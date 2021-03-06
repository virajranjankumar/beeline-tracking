const _ = require('lodash')
const AWS = require('aws-sdk')
const df = require('dateformat')
const moment = require('moment-timezone')
const TelegramBot = require('node-telegram-bot-api')

const loadEventSubscriptions = dynamoDb => transportCompanyId => {
  return new Promise((resolve, reject) => {
    const params = {
      TableName: process.env.EVENT_SUBS_TABLE,
      Key: { transportCompanyId },
    }
    dynamoDb.get(params, (error, data) => {
      if (error) {
        reject(error)
      } else {
        resolve([transportCompanyId, (data.Item || {}).subscriptions || []])
      }
    })
  })
}

const EVENT_TO_PAYLOAD = {
  noPings: event => ({
    message:
      `Driver app was not switched on ` +
      `${Math.floor(Number(event.delayInMins.N))} mins before start of ` +
      `${event.trip.M.route.M.label.S} ` +
      `${event.trip.M.route.M.from.S} to ${event.trip.M.route.M.to.S} (on ${df(
        event.trip.M.date.S,
        'd mmm yyyy'
      )})`,
    severity: Number(event.delayInMins.N) <= 5 ? 5 : 4,
  }),
  lateArrival: event => ({
    message:
      `Bus arrived ${Math.floor(Number(event.delayInMins.N))} mins late ${
        event.trip.M.route.M.label.S
      } ` +
      `${event.trip.M.route.M.from.S} to ${event.trip.M.route.M.to.S} (${df(
        event.trip.M.date.S,
        'd mmm yyyy'
      )})`,
  }),
  lateETA: event => ({
    message:
      `Bus may be ${Math.floor(Number(event.delayInMins.N))} mins late ${
        event.trip.M.route.M.label.S
      } ` +
      `${event.trip.M.route.M.from.S} to ${event.trip.M.route.M.to.S} (${df(
        event.trip.M.date.S,
        'd mmm yyyy'
      )})`,
  }),
}

const isPublishNoPings = record => {
  const { OldImage, NewImage } = record.dynamodb
  const publish =
    record.eventName === 'MODIFY' &&
    NewImage.type.S === 'noPings' &&
    Number(NewImage.time.N) - Number(OldImage.time.N) > 60 * 60 * 1000 &&
    NewImage.activeTrip &&
    NewImage.activeTrip.BOOL
  if (NewImage) {
    const routeId = NewImage.trip.M.routeId.N
    console.log(
      `${routeId} - ${record.eventName} ${NewImage.type.S}
      at: ${NewImage.time.N} from: ${OldImage.time.N}
      active: ${NewImage.activeTrip && NewImage.activeTrip.BOOL} -> ${publish}`
    )
  }
  return publish
}

const sendToTelegram = (bot, payload) => subscriber => {
  const { agent: { notes: { telegramChatId } } } = subscriber
  let criticality =
    payload.severity && payload.severity >= 6
      ? 'EMERGNCY'
      : payload.severity && payload.severity >= 5 ? 'CRITICAL' : 'OPS'

  const message = `[${criticality}] ${payload.message} Sent: ${moment
    .tz(new Date(), 'Asia/Singapore')
    .format('HH:mm:ss')}`
  console.log(`Sending ${telegramChatId} - ${message}`)
  return bot.sendMessage(telegramChatId, message)
}

const makePublish = (lookupEventSubscriptions, bot) => (
  event,
  context,
  callback
) => {
  const eventsToPublish = event.Records.filter(
    record => record.eventName === 'INSERT' || isPublishNoPings(record)
  )
    .map(record => record.dynamodb.NewImage)
    .filter(
      event =>
        event.trip.M.date.S ===
        moment.tz(new Date(), 'Asia/Singapore').format('YYYY-MM-DD')
    )

  const transportCompanyIds = eventsToPublish.map(event =>
    Number(event.trip.M.route.M.transportCompanyId.N)
  )

  return Promise.all(transportCompanyIds.map(lookupEventSubscriptions))
    .then(_.fromPairs)
    .then(subsByCompany => {
      const publishPromises = eventsToPublish.map(event => {
        const routeId = Number(event.trip.M.routeId.N)
        const type = event.type.S
        const delayInMins = ['noPings', 'lateETA', 'lateArrival'].includes(type)
          ? Number(event.delayInMins.N)
          : undefined
        const transportCompanyId = Number(
          event.trip.M.route.M.transportCompanyId.N
        )
        const relevantSubscribers = (
          subsByCompany[transportCompanyId] || []
        ).filter(
          sub =>
            sub.event === type &&
            (!sub.params.routeIds || sub.params.routeIds.includes(routeId)) &&
            (!delayInMins ||
              (sub.params.minsBefore || []).includes(delayInMins) ||
              sub.params.timeAfter <= delayInMins * 60000)
        )
        const subscribersByHandler = _.groupBy(
          relevantSubscribers || [],
          'handler'
        )
        console.warn('WARN: Only handling telegram subscribers')
        const telegramSubscribers = subscribersByHandler.telegram
        if (
          telegramSubscribers &&
          telegramSubscribers.length &&
          typeof EVENT_TO_PAYLOAD[type] === 'function'
        ) {
          const payload = EVENT_TO_PAYLOAD[type](event)
          return Promise.all(
            telegramSubscribers.map(sendToTelegram(bot, payload))
          )
        } else {
          return Promise.resolve()
        }
      })
      return Promise.all(publishPromises)
    })
    .then(() => callback(null, { message: 'Done' }))
    .catch(err => callback(null, err))
}

module.exports.makePublish = makePublish
module.exports.publish = makePublish(
  loadEventSubscriptions(new AWS.DynamoDB.DocumentClient()),
  new TelegramBot(process.env.TELEGRAM_TOKEN)
)
