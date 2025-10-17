// index.js — версия с открытым меню-сайтом и POST /menu-order
// С полным логированием для отладки

// ---------------------------- Imports ----------------------------
const { generateText } = require('ai');
const { openai } = require('@ai-sdk/openai');
const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const { MongoClient } = require('mongodb');
const path = require('path');

// ---------------------------- Config ----------------------------
const PORT = process.env.PORT || 3500;
const app = express().use(body_parser.json());

const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN;

const TEMIR_API_BASE = 'https://ya.temir.me';
const MENU_URL = process.env.MENU_URL;

// Flow IDs
const NEW_CUSTOMER_FLOW_ID = '822959930422520';
const ORDER_FLOW_ID = '1265635731924331';
const NEW_CUSTOMER_FLOW_ID_KY = '762432499878824';
const ORDER_FLOW_ID_KY = '769449935850843';

// MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'whatsapp_bot';
let db = null;
let userStatesCollection = null;
let userDataForOrderCollection = null;

// Флаги инициализации
let isInitialized = false;
let initPromise = null;

const IS_VERCEL = !!process.env.VERCEL;

const cors = require('cors');
app.use(cors({ origin: MENU_URL ? new URL(MENU_URL).origin : '*' }));


// ---------------------------- States ----------------------------
const WAITING_STATES = {
  NONE: 'none',
  LANG: 'lang',
  FLOW_RESPONSE: 'flow_response',
  LOCATION: 'location',
  CATALOG_ORDER: 'catalog_order',
  ORDER_STATUS: 'order-status',
  HELP_CONFIRM: 'help_confirm'
};

const contact_branch = {
  '1': '0709063676',
  '15': '0705063676',
  '32': '0704063676'
};

// ---------------------------- ERR map ----------------------------
const ERR = {
  LOCATION_CLOSED: 'LOCATION_CLOSED',
  SOLD_OUT: 'SOLD_OUT',
  DELIVERY_UNAVAILABLE: 'DELIVERY_UNAVAILABLE',
  VALIDATION: 'VALIDATION',
  UNKNOWN: 'UNKNOWN',
  MIN_AMOUNT: 'MIN_AMOUNT',
};

// ---------------------------- AI Intent ----------------------------
async function analyzeCustomerIntent(messageText) {
  console.log('🤖 [AI] Анализ намерения пользователя:', messageText);
  try {
    const { text } = await generateText({
      model: openai('gpt-4o'),
      messages: [
        {
          role: 'system',
          content: `Ты классификатор намерений для ресторана "Yaposhkin Rolls".
Формат ответа: "<INTENT>|<lang>" и ничего больше.

ЯЗЫК:
- <lang> = "kg", если есть кыргызские слова (буйрутма, салам, кандайсыз, качан, канча, алып кетүү, төлөө, setter, көзөмөлдөө и т.п.), иначе "ru".

ГЛАВНОЕ ПРАВИЛО:
- Если сообщение НЕ является вопросом, то ВСЕГДА возвращай: ORDER_INTENT|<lang>.

Сообщение считается ВОПРОСОМ если:
1) оканчивается на "?" или "؟", ИЛИ
2) начинается с вопросительного слова:
   RU: как, когда, где, что, сколько, зачем, можно, какой, какие, куда, откуда
   KG: кантип, качан, кайда, эмне, канча, болобу

ЕСЛИ ЭТО ВОПРОС, тогда классифицируй:
- ORDER_STATUS: статус заказа, готов/когда будет, где мой заказ, сколько ждать
- ORDER_TRACKING: как отслеживать заказ, будет ли уведомление
- PICKUP_ADDRESS: адрес самовывоза, где находитесь, адреса филиалов
- MENU_QUESTION: вопросы о меню/составах/наличии категорий
- ORDER_FOR_ANOTHER: можно ли заказать на другого человека
- PAYMENT_METHOD: оплата картой/онлайн/терминал
- OTHER_INTENT: всё прочее не из списка

Возвращай строго одну строку "<INTENT>|<lang>".`
        },
        { role: 'user', content: messageText || '' }
      ],
      maxTokens: 20,
      temperature: 0.0
    });

    const parts = (text || '').trim().split('|');
    if (parts.length >= 2) {
      const intent = parts[0].trim();
      const language = parts[1].trim();
      console.log('✅ [AI] Определено намерение:', intent, 'язык:', language);
      return { intent, isOrderIntent: intent === 'ORDER_INTENT', language, originalText: messageText };
    }
    console.log('⚠️ [AI] Fallback на простой анализ');
    return analyzeIntentFallback(messageText);
  } catch (error) {
    console.error('❌ [AI] Ошибка анализа:', error.message);
    return analyzeIntentFallback(messageText);
  }
}

// Fallback
function analyzeIntentFallback(messageText) {
  console.log('🔄 [AI Fallback] Простой анализ текста');
  const text = (messageText || '').toLowerCase();

  const kgWords = ['буйрутма', 'заказ кылгым', 'салам', 'кандайсыз', 'качан', 'канча'];
  const language = kgWords.some(w => text.includes(w)) ? 'kg' : 'ru';

  const statusKeywords = ['когда будет готов', 'готов ли заказ', 'статус заказа', 'где мой заказ', 'сколько ждать', 'заказ качан', 'буйрутма даярбы'];
  if (statusKeywords.some(w => text.includes(w))) {
    console.log('📊 [AI Fallback] ORDER_STATUS');
    return { intent: 'ORDER_STATUS', isOrderIntent: false, language, originalText: messageText };
  }

  const trackingKeywords = ['как отслеживать', 'как узнать статус', 'отслеживание заказа', 'уведомления', 'кантип көзөмөлдөө'];
  if (trackingKeywords.some(w => text.includes(w))) {
    console.log('🔍 [AI Fallback] ORDER_TRACKING');
    return { intent: 'ORDER_TRACKING', isOrderIntent: false, language, originalText: messageText };
  }

  const addressKeywords = ['адрес самовывоза', 'где находитесь', 'адреса филиалов', 'куда приехать', 'алып кетүү дареги'];
  if (addressKeywords.some(w => text.includes(w))) {
    console.log('📍 [AI Fallback] PICKUP_ADDRESS');
    return { intent: 'PICKUP_ADDRESS', isOrderIntent: false, language, originalText: messageText };
  }

  const menuKeywords = ['есть ли сеты', 'есть ли пицца', 'есть ли бургеры', 'картошка фри', 'полное меню', 'сеттер барбы', 'меню'];
  if (menuKeywords.some(w => text.includes(w))) {
    console.log('🍽️ [AI Fallback] MENU_QUESTION');
    return { intent: 'MENU_QUESTION', isOrderIntent: false, language, originalText: messageText };
  }

  const anotherPersonKeywords = ['заказ на другого', 'не на себя', 'для кого-то', 'башка адамга'];
  if (anotherPersonKeywords.some(w => text.includes(w))) {
    console.log('👥 [AI Fallback] ORDER_FOR_ANOTHER');
    return { intent: 'ORDER_FOR_ANOTHER', isOrderIntent: false, language, originalText: messageText };
  }

  const paymentKeywords = ['оплата картой', 'можно ли картой', 'принимаете карты', 'онлайн оплата', 'карта менен', 'төлөө'];
  if (paymentKeywords.some(w => text.includes(w))) {
    console.log('💳 [AI Fallback] PAYMENT_METHOD');
    return { intent: 'PAYMENT_METHOD', isOrderIntent: false, language, originalText: messageText };
  }

  const orderKeywords = ['заказ', 'заказать', 'хочу', 'буду', 'доставка', 'роллы', 'суши', 'каталог', 'буйрутма'];
  if (orderKeywords.some(w => text.includes(w))) {
    console.log('🛒 [AI Fallback] ORDER_INTENT');
    return { intent: 'ORDER_INTENT', isOrderIntent: true, language, originalText: messageText };
  }

  console.log('❓ [AI Fallback] OTHER_INTENT');
  return { intent: 'OTHER_INTENT', isOrderIntent: false, language, originalText: messageText };
}

// ---------------------------- MongoDB Init ----------------------------

async function initMongoDB() {
  console.log('🔄 [MongoDB] Начало инициализации...');
  try {
    const uri = MONGODB_URI;
    if (IS_VERCEL && (!uri || uri.startsWith('mongodb://localhost'))) {
      throw new Error('Set remote MONGODB_URI (Atlas) for Vercel');
    }
    
    console.log('📡 [MongoDB] Подключение к:', uri.substring(0, 20) + '...');
    const client = new MongoClient(uri);
    await client.connect();
    console.log('✅ [MongoDB] Успешное подключение');
    
    db = client.db(DB_NAME);
    userStatesCollection = db.collection('user_states');
    userDataForOrderCollection = db.collection('user_orders');
    
    console.log('📊 [MongoDB] Создание индексов...');
    await userStatesCollection.createIndex({ phone: 1 });
    await userStatesCollection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 86400 });
    await userDataForOrderCollection.createIndex({ phone: 1 });
    await userDataForOrderCollection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 86400 });
    
    console.log('✅ [MongoDB] Индексы созданы');
    console.log('✅ [MongoDB] Инициализация завершена');
  } catch (error) {
    console.error('❌ [MongoDB] Ошибка инициализации:', error.message);
    throw error;
  }
}

// Функция для гарантии инициализации
async function ensureInitialized() {
  if (isInitialized) {
    return;
  }
  
  if (!initPromise) {
    console.log('🚀 [Init] Запуск процесса инициализации...');
    initPromise = (async () => {
      try {
        await initMongoDB();
        await getAllProductsForSections();
        isInitialized = true;
        console.log('✅ [Init] Полная инициализация завершена');
      } catch (error) {
        console.error('❌ [Init] Критическая ошибка:', error);
        initPromise = null;
        throw error;
      }
    })();
  }
  
  await initPromise;
}

// Middleware для проверки инициализации
app.use(async (req, res, next) => {
  try {
    await ensureInitialized();
    next();
  } catch (error) {
    console.error('❌ [Middleware] Сервис не инициализирован:', error.message);
    res.status(503).json({ 
      error: 'Service initializing', 
      message: 'Please retry in a few seconds' 
    });
  }
});

// ---------------------------- DB Helpers ----------------------------
async function getUserState(phone) {
  console.log('📖 [DB] Получение состояния для:', phone);
  const doc = await userStatesCollection.findOne({ phone });
  console.log('✅ [DB] Состояние:', doc?.state ? 'найдено' : 'отсутствует');
  return doc?.state || null;
}

async function setUserState(phone, state) {
  console.log('💾 [DB] Сохранение состояния для:', phone);
  const now = new Date();
  await userStatesCollection.updateOne(
    { phone },
    { $set: { phone, state, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  console.log('✅ [DB] Состояние сохранено');
}

async function deleteUserState(phone) {
  console.log('🗑️ [DB] Удаление состояния для:', phone);
  await userStatesCollection.deleteOne({ phone });
  console.log('✅ [DB] Состояние удалено');
}

async function getUserLan(phone) {
  console.log('🌐 [DB] Получение языка для:', phone);
  const doc = await userStatesCollection.findOne({ phone });
  const lan = doc?.lan || 'ru';
  console.log('✅ [DB] Язык:', lan);
  return lan;
}

async function getUserOrders(phone) {
  console.log('📦 [DB] Получение заказов для:', phone);
  const doc = await userDataForOrderCollection.findOne({ phone });
  return doc?.state || null;
}

async function setUserOrder(phone, state) {
  console.log('💾 [DB] Сохранение заказа для:', phone);
  const now = new Date();
  await userDataForOrderCollection.updateOne(
    { phone },
    { $set: { phone, state, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  console.log('✅ [DB] Заказ сохранен');
}

async function deleteUserOrders(phone) {
  console.log('🗑️ [DB] Удаление заказов для:', phone);
  await userDataForOrderCollection.deleteOne({ phone });
  console.log('✅ [DB] Заказы удалены');
}

async function getUserWaitingState(phone) {
  console.log('⏳ [DB] Получение waiting state для:', phone);
  const doc = await userStatesCollection.findOne({ phone });
  const state = doc?.waitingState || WAITING_STATES.NONE;
  console.log('✅ [DB] Waiting state:', state);
  return state;
}

async function setUserWaitingState(phone, waitingState, lan) {
  console.log('💾 [DB] Установка waiting state:', waitingState, 'для:', phone);
  const now = new Date();
  const $set = { phone, waitingState, updatedAt: now };
  if (waitingState === WAITING_STATES.FLOW_RESPONSE && lan) $set.lan = lan;
  await userStatesCollection.updateOne(
    { phone },
    { $set, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  console.log('✅ [DB] Waiting state установлен');
}

async function clearUserWaitingState(phone) {
  console.log('🧹 [DB] Очистка waiting state для:', phone);
  await userStatesCollection.updateOne(
    { phone },
    { $unset: { waitingState: "" }, $set: { updatedAt: new Date() } }
  );
  console.log('✅ [DB] Waiting state очищен');
}

// ---------- Resume checkpoint ----------
async function setResumeCheckpoint(phone, resume) {
  console.log('📍 [DB] Сохранение checkpoint:', resume.kind, 'для:', phone);
  const now = new Date();
  await userStatesCollection.updateOne(
    { phone },
    { $set: { resume, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  console.log('✅ [DB] Checkpoint сохранен');
}

async function getResumeCheckpoint(phone) {
  console.log('📖 [DB] Получение checkpoint для:', phone);
  const doc = await userStatesCollection.findOne({ phone });
  console.log('✅ [DB] Checkpoint:', doc?.resume ? doc.resume.kind : 'отсутствует');
  return doc?.resume || null;
}

async function clearResumeCheckpoint(phone) {
  console.log('🧹 [DB] Очистка checkpoint для:', phone);
  await userStatesCollection.updateOne(
    { phone },
    { $unset: { resume: "" }, $set: { updatedAt: new Date() } }
  );
  console.log('✅ [DB] Checkpoint очищен');
}

// ---------- Utils ----------
function normalizePhone(p) {
  return String(p || '').replace(/[^\d]/g, '');
}

// ---------------------------- Server start ----------------------------
(async () => {
  console.log('🚀 [Startup] Запуск сервера...');
  console.log('🔧 [Startup] Режим:', IS_VERCEL ? 'Vercel' : 'Local');
  console.log('🔧 [Startup] PORT:', PORT);
  
  if (!IS_VERCEL) {
    try {
      await ensureInitialized();
      app.listen(PORT, () => {
        console.log('✅ [Server] Сервер запущен на http://localhost:' + PORT);
        console.log('✅ [Server] Готов к приему запросов');
      });
    } catch (error) {
      console.error('❌ [Startup] Критическая ошибка:', error);
      process.exit(1);
    }
  } else {
    console.log('✅ [Vercel] Экспорт модуля для Vercel');
  }
})();

module.exports = app;

// ---------------------------- Verify webhook ----------------------------
app.get("/webhook", (req, res) => {
  console.log('📥 [Webhook] GET запрос верификации');
  const mode = req.query["hub.mode"];
  const challenge = req.query["hub.challenge"];
  const tokenQ = req.query["hub.verify_token"];
  
  console.log('🔐 [Webhook] Mode:', mode, 'Token match:', tokenQ === mytoken);
  
  if (mode && tokenQ) {
    if (mode === "subscribe" && tokenQ === mytoken) {
      console.log('✅ [Webhook] Верификация успешна');
      res.status(200).send(challenge);
    } else {
      console.log('❌ [Webhook] Неверный токен');
      res.status(403).send("Forbidden");
    }
  }
});

// ---------------------------- Webhook main ----------------------------
app.post("/webhook", async (req, res) => {
  console.log('📨 [Webhook] POST запрос получен');
  const body_param = req.body;

  if (body_param.object &&
      body_param.entry &&
      body_param.entry[0].changes &&
      body_param.entry[0].changes[0].value.messages &&
      body_param.entry[0].changes[0].value.messages[0]) {

    const phone_no_id = body_param.entry[0].changes[0].value.metadata.phone_number_id;
    const from = body_param.entry[0].changes[0].value.messages[0].from;
    const message = body_param.entry[0].changes[0].value.messages[0];
    
    console.log('👤 [Webhook] Сообщение от:', from);
    console.log('📝 [Webhook] Тип сообщения:', message.type);
    
    const currentWaitingState = await getUserWaitingState(from);
    console.log('⏳ [Webhook] Текущий waiting state:', currentWaitingState);

    try {
      // 1) Локация
      if (message.type === "location" && currentWaitingState === WAITING_STATES.LOCATION) {
        console.log('📍 [Handler] Обработка локации');
        await handleLocationMessage(phone_no_id, from, message);
      }
      // 2) Ответ от Flow
      else if (message.type === "interactive" &&
               message.interactive?.type === "nfm_reply" &&
               currentWaitingState === WAITING_STATES.FLOW_RESPONSE) {
        console.log('🔄 [Handler] Обработка Flow ответа');
        await handleFlowResponse(phone_no_id, from, message, body_param);
      }
      // 3) Заказ из каталога
      else if (message.type === "order" &&
               currentWaitingState === WAITING_STATES.CATALOG_ORDER) {
        console.log('🛒 [Handler] Обработка заказа из каталога');
        await handleCatalogOrderResponse(phone_no_id, from, message);
      }
      // 4) Кнопки выбора языка
      else if (message.type === "interactive" &&
               message.interactive?.type === "button_reply" &&
               currentWaitingState === WAITING_STATES.LANG) {
        console.log('🌐 [Handler] Обработка выбора языка');
        await handleOrderConfirmationButton(phone_no_id, from, message);
      }
      // 5) Кнопки продолжить/отменить
      else if (message.type === "interactive" &&
               message.interactive?.type === "button_reply" &&
               currentWaitingState === WAITING_STATES.HELP_CONFIRM) {
        const id = message.interactive.button_reply.id;
        console.log('🔘 [Handler] Кнопка помощи:', id);
        if (id === 'continue_order') {
          console.log('▶️ [Handler] Продолжение заказа');
          await resumeFlow(phone_no_id, from);
        } else if (id === 'cancel_order') {
          console.log('❌ [Handler] Отмена заказа');
          const lan = await getUserLan(from);
          await deleteUserState(from);
          await clearResumeCheckpoint(from);
          await setUserWaitingState(from, WAITING_STATES.NONE);
          await sendMessage(phone_no_id, from, lan === 'kg' ? '✅ Буйрутмаңыз жокко чыгарылды.' : '✅ Ваш заказ отменен.');
        }
      }
      // 6) Вопрос в середине процесса
      else if (message.type === "text" &&
              (currentWaitingState === WAITING_STATES.FLOW_RESPONSE || 
               currentWaitingState === WAITING_STATES.CATALOG_ORDER || 
               currentWaitingState === WAITING_STATES.LOCATION ||
               currentWaitingState === WAITING_STATES.HELP_CONFIRM)) {
        console.log('❓ [Handler] Вопрос в середине оформления');
        await handleMidOrderHelp(phone_no_id, from, message, currentWaitingState, body_param);
      }
      // 7) Обычное текстовое сообщение
      else if (message.type === "text" && currentWaitingState === WAITING_STATES.NONE) {
        console.log('💬 [Handler] Обычное сообщение');
        await handleIncomingMessage(phone_no_id, from, message);
      } else {
        console.log('⚠️ [Handler] Необработанный тип сообщения');
      }
    } catch (e) {
      console.error("❌ [Webhook] Ошибка обработки:", e.message);
      console.error("❌ [Webhook] Stack:", e.stack);
    }

    return res.sendStatus(200);
  }

  console.log('⚠️ [Webhook] Невалидный формат запроса');
  res.sendStatus(404);
});

// ---------------------------- HELP: mid-order Q&A ----------------------------
async function handleMidOrderHelp(phone_no_id, from, message, currentWaitingState, body_param) {
  console.log('🆘 [Help] Запрос помощи в середине оформления');
  const text = message.text?.body || '';
  console.log('💬 [Help] Текст вопроса:', text);
  
  const analysis = await analyzeCustomerIntent(text);
  console.log('🔍 [Help] Результат анализа:', analysis.intent);

  let heavyMedia = false;

  // Шаблонные ответы
  if (analysis.intent === 'ORDER_STATUS') {
    console.log('📊 [Help] Отправка информации о статусе');
    await sendOrderStatusResponse(phone_no_id, from, analysis.language);
  } else if (analysis.intent === 'ORDER_TRACKING') {
    console.log('🔍 [Help] Отправка информации об отслеживании');
    await sendOrderTrackingResponse(phone_no_id, from, analysis.language);
  } else if (analysis.intent === 'PICKUP_ADDRESS') {
    console.log('📍 [Help] Отправка адресов самовывоза');
    await sendPickupAddressResponse(phone_no_id, from, analysis.language);
  } else if (analysis.intent === 'MENU_QUESTION') {
    console.log('🍽️ [Help] Отправка меню');
    await sendMenuResponse(phone_no_id, from, analysis.language);
    heavyMedia = true;
  } else if (analysis.intent === 'ORDER_FOR_ANOTHER') {
    console.log('👥 [Help] Информация о заказе на другого');
    await sendOrderForAnotherResponse(phone_no_id, from, analysis.language);
  } else if (analysis.intent === 'PAYMENT_METHOD') {
    console.log('💳 [Help] Информация об оплате');
    await sendPaymentMethodResponse(phone_no_id, from, analysis.language);
  } else if (analysis.intent === 'OTHER_INTENT') {
    console.log('📞 [Help] Отправка контакта менеджера');
    await sendManagerContactMessage(phone_no_id, from, analysis.language);
  } else {
    console.log('⚠️ [Help] Стандартный ответ');
    const lan = await getUserLan(from);
    await sendMessage(phone_no_id, from, lan === 'kg'
      ? 'Төмөнкү баскычтардын бирин тандаңыз.'
      : 'Выберите один из вариантов ниже.');
  }

  // Чекпоинт
  const resume = await getResumeCheckpoint(from);
  if (!resume) {
    console.log('📍 [Help] Создание checkpoint');
    if (currentWaitingState === WAITING_STATES.FLOW_RESPONSE) {
      await setResumeCheckpoint(from, { kind: 'flow' });
    } else if (currentWaitingState === WAITING_STATES.CATALOG_ORDER) {
      await setResumeCheckpoint(from, { kind: 'catalog' });
    }
  }

  await setUserWaitingState(from, WAITING_STATES.HELP_CONFIRM);

  if (heavyMedia) {
    console.log('⏸️ [Help] Пауза перед кнопками (тяжелое медиа)');
    await sleep(1500);
  }

  console.log('🔘 [Help] Отправка кнопок продолжения');
  await sendHelpContinueButtons(phone_no_id, from);
}

async function sendHelpContinueButtons(phone_no_id, to) {
  console.log('📤 [WA] Отправка кнопок помощи для:', to);
  const lan = await getUserLan(to);
  const buttonsMessage = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: lan === 'kg' ? "Сурооңуз боюнча жооп берилди" : "Ответ на ваш вопрос" },
      body: { text: lan === 'kg' ? "Буйрутманы улантууну каалайсызбы?" : "Продолжить оформление заказа?" },
      footer: { text: "Yaposhkin Rolls" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "continue_order", title: lan === 'kg' ? "Буйрутманы улантуу" : "Продолжить заказ" } },
          { type: "reply", reply: { id: "cancel_order", title: lan === 'kg' ? "Жокко чыгаруу" : "Отменить" } }
        ]
      }
    }
  };
  await sendWhatsAppMessage(phone_no_id, buttonsMessage);
  console.log('✅ [WA] Кнопки помощи отправлены');
}

// Продолжить процесс по чекпоинту
async function resumeFlow(phone_no_id, from) {
  console.log('▶️ [Resume] Возобновление процесса для:', from);
  const lan = await getUserLan(from);
  const resume = await getResumeCheckpoint(from);

  if (!resume) {
    console.log('⚠️ [Resume] Checkpoint не найден');
    await setUserWaitingState(from, WAITING_STATES.NONE);
    await sendMessage(phone_no_id, from, lan === 'kg'
      ? 'Кечиресиз, улантуучу кадам табылган жок.'
      : 'Извините, нечего возобновлять.');
    return;
  }

  console.log('📍 [Resume] Найден checkpoint:', resume.kind);
  if (resume.kind === 'flow') {
    console.log('🔄 [Resume] Возобновление Flow');
    await checkCustomerAndSendFlow(phone_no_id, from, lan);
    await setUserWaitingState(from, WAITING_STATES.FLOW_RESPONSE, lan);
  } else if (resume.kind === 'catalog') {
    console.log('🛒 [Resume] Возобновление каталога');
    await sendMenuLink(phone_no_id, from);
    await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
  } else {
    console.log('⚠️ [Resume] Неизвестный тип checkpoint');
    await setUserWaitingState(from, WAITING_STATES.NONE);
  }
}

// ---------------------------- WhatsApp helpers ----------------------------
async function sendWhatsAppMessage(phone_no_id, messageData) {
  console.log('📤 [WA API] Отправка сообщения...');
  try {
    const response = await axios({
      method: "POST",
      url: `https://graph.facebook.com/v23.0/${phone_no_id}/messages?access_token=${token}`,
      data: messageData,
      headers: { "Content-Type": "application/json" }
    });
    console.log('✅ [WA API] Сообщение отправлено, ID:', response.data.messages?.[0]?.id);
    return response.data;
  } catch (error) {
    console.error('❌ [WA API] Ошибка отправки:', error.response?.data || error.message);
    throw error;
  }
}

async function sendMessage(phone_no_id, to, text) {
  console.log('📝 [WA] Отправка текста:', text.substring(0, 50) + '...');
  const data = { messaging_product: "whatsapp", to, text: { body: text || "Сообщение" } };
  return await sendWhatsAppMessage(phone_no_id, data);
}

// ---------------------------- Language choose ----------------------------
async function handleOrderConfirmationButton(phone_no_id, from, message) {
  console.log('🌐 [Language] Обработка выбора языка');
  try {
    const buttonId = message.interactive.button_reply.id;
    console.log('🌐 [Language] Выбран язык:', buttonId);
    await handleIncomingMessage(phone_no_id, from, message, buttonId);
  } catch (error) {
    console.error('❌ [Language] Ошибка:', error.message);
    await sendMessage(phone_no_id, from, "Ошибка. Попробуйте еще раз.");
  }
}

async function sendOrderConfirmationButtons(phone_no_id, to) {
  console.log('📤 [WA] Отправка кнопок выбора языка');
  const buttonsMessage = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Кош келиниз!\nДобро пожаловать!" },
      body: { text: "📋 Тилди танданыз.\n\n📋 Выберите язык обслуживания." },
      footer: { text: "Yaposhkin Rolls" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "kg", title: "Кыргыз тил" } },
          { type: "reply", reply: { id: "ru", title: "Русский" } }
        ]
      }
    }
  };
  await setUserWaitingState(to, WAITING_STATES.LANG);
  await sendWhatsAppMessage(phone_no_id, buttonsMessage);
  console.log('✅ [WA] Кнопки языка отправлены');
}

// ---------------------------- High-level flow entry ----------------------------
async function handleIncomingMessage(phone_no_id, from, message, buttonLang = null) {
  console.log('📨 [Message] Обработка входящего сообщения');
  const messageText = message.text?.body || '';

  if (buttonLang) {
    console.log('🌐 [Message] Язык из кнопки:', buttonLang);
    await checkCustomerAndSendFlow(phone_no_id, from, buttonLang);
    return;
  }

  try {
    const intent = await analyzeCustomerIntent(messageText);
    console.log('🎯 [Message] Intent:', intent.intent);
    
    switch (intent.intent) {
      case 'ORDER_INTENT':
        console.log('🛒 [Message] Запуск процесса заказа');
        await sendOrderConfirmationButtons(phone_no_id, from);
        break;
      case 'ORDER_STATUS':
        console.log('📊 [Message] Запрос статуса заказа');
        await sendOrderStatusResponse(phone_no_id, from, intent.language);
        break;
      case 'ORDER_TRACKING':
        console.log('🔍 [Message] Запрос об отслеживании');
        await sendOrderTrackingResponse(phone_no_id, from, intent.language);
        break;
      case 'PICKUP_ADDRESS':
        console.log('📍 [Message] Запрос адресов');
        await sendPickupAddressResponse(phone_no_id, from, intent.language);
        break;
      case 'MENU_QUESTION':
        console.log('🍽️ [Message] Запрос меню');
        await sendMenuResponse(phone_no_id, from, intent.language);
        break;
      case 'ORDER_FOR_ANOTHER':
        console.log('👥 [Message] Вопрос о заказе на другого');
        await sendOrderForAnotherResponse(phone_no_id, from, intent.language);
        break;
      case 'PAYMENT_METHOD':
        console.log('💳 [Message] Вопрос об оплате');
        await sendPaymentMethodResponse(phone_no_id, from, intent.language);
        break;
      case 'OTHER_INTENT':
      default:
        console.log('📞 [Message] Перенаправление к менеджеру');
        await sendManagerContactMessage(phone_no_id, from, intent.language);
        break;
    }
  } catch (error) {
    console.error('❌ [Message] Ошибка обработки:', error.message);
    await sendOrderConfirmationButtons(phone_no_id, from);
  }
}

// ---------------------------- Flow router ----------------------------
async function checkCustomerAndSendFlow(phone_no_id, from, lan) {
  console.log('🔄 [Flow] Проверка клиента и отправка Flow');
  console.log('👤 [Flow] Телефон:', from, 'Язык:', lan);
  
  try {
    console.log('📡 [API] Запрос списка ресторанов...');
    const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
    const restaurants = restaurantsResponse.data;
    console.log('✅ [API] Получено ресторанов:', restaurants.length);
    
    const branches = restaurants.map(r => ({ id: r.external_id.toString(), title: `🏪 ${r.title}` }));

    console.log('📡 [API] Запрос данных клиента...');
    const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
    const customerData = customerResponse.data;
    console.log('✅ [API] Данные клиента получены');

    const hasAddresses = customerData.customer.addresses && customerData.customer.addresses.length > 0;
    const isNewCustomer = !hasAddresses || !customerData.customer.first_name || customerData.customer.first_name === 'Имя';

    console.log('👤 [Flow] Клиент:', isNewCustomer ? 'НОВЫЙ' : 'СУЩЕСТВУЮЩИЙ');
    console.log('📍 [Flow] Адресов:', customerData.customer.addresses?.length || 0);

    if (isNewCustomer) {
      console.log('🆕 [Flow] Отправка Flow для нового клиента');
      if (lan === 'kg') await sendNewCustomerFlowKy(phone_no_id, from, branches);
      else await sendNewCustomerFlow(phone_no_id, from, branches);

      await setResumeCheckpoint(from, { kind: 'flow' });
    } else {
      console.log('👤 [Flow] Отправка Flow для существующего клиента');
      if (lan === 'kg') await sendExistingCustomerFlowKy(phone_no_id, from, customerData.customer, branches);
      else await sendExistingCustomerFlow(phone_no_id, from, customerData.customer, branches);

      await setResumeCheckpoint(from, { kind: 'flow' });
    }

    await setUserWaitingState(from, WAITING_STATES.FLOW_RESPONSE, lan);
    console.log('✅ [Flow] Flow отправлен успешно');
  } catch (error) {
    console.error('❌ [Flow] Ошибка:', error.message);
    console.log('🔄 [Flow] Попытка отправки Flow для нового клиента (fallback)');
    
    try {
      const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
      const restaurants = restaurantsResponse.data;
      const branches = restaurants.map(r => ({ id: r.external_id.toString(), title: `🏪 ${r.title}` }));
      await sendNewCustomerFlow(phone_no_id, from, branches);
      await setUserWaitingState(from, WAITING_STATES.FLOW_RESPONSE, lan);
      await setResumeCheckpoint(from, { kind: 'flow' });
      console.log('✅ [Flow] Fallback Flow отправлен');
    } catch (fallbackError) {
      console.error('❌ [Flow] Критическая ошибка fallback:', fallbackError.message);
      await sendMessage(phone_no_id, from, "Извините, технические проблемы. Попробуйте позже.");
    }
  }
}

// ---------------------------- Flow messages ----------------------------
async function sendNewCustomerFlow(phone_no_id, from, branches) {
  console.log('📤 [Flow] Отправка RU Flow для нового клиента');
  const flowData = {
    messaging_product: "whatsapp",
    to: from,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: "🍣 Yaposhkin Rolls" },
      body: { text: "Добро пожаловать!" },
      footer: { text: "Заполните форму регистрации" },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: `new_customer_${Date.now()}`,
          flow_id: NEW_CUSTOMER_FLOW_ID,
          flow_cta: "Зарегистрироваться",
          flow_action: "navigate",
          flow_action_payload: { screen: "WELCOME_NEW", data: { flow_type: "new_customer", branches } }
        }
      }
    }
  };
  await sendWhatsAppMessage(phone_no_id, flowData);
  console.log('✅ [Flow] RU Flow отправлен');
}

async function sendNewCustomerFlowKy(phone_no_id, from, branches) {
  console.log('📤 [Flow] Отправка KG Flow для нового клиента');
  const flowData = {
    messaging_product: "whatsapp",
    to: from,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: "🍣 Yaposhkin Rolls" },
      body: { text: "Кош келиңиз!\n\nДобро пожаловать!" },
      footer: { text: "Каттоо формасын толтурунуз" },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: `new_customer_${Date.now()}`,
          flow_id: NEW_CUSTOMER_FLOW_ID_KY,
          flow_cta: "Каттоо",
          flow_action: "navigate",
          flow_action_payload: { screen: "WELCOME_NEW", data: { flow_type: "new_customer", branches } }
        }
      }
    }
  };
  await sendWhatsAppMessage(phone_no_id, flowData);
  console.log('✅ [Flow] KG Flow отправлен');
}

async function sendExistingCustomerFlow(phone_no_id, from, customer, branches) {
  console.log('📤 [Flow] Отправка RU Flow для существующего клиента');
  console.log('👤 [Flow] Имя клиента:', customer.first_name);
  console.log('📍 [Flow] Адресов:', customer.addresses?.length || 0);
  
  const addresses = customer.addresses.map(a => ({ id: `address_${a.id}`, title: a.full_address }));
  addresses.push({ id: "new", title: "➕ Новый адрес" });

  const flowData = {
    messaging_product: "whatsapp",
    to: from,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: "🛒 Оформление заказа" },
      body: { text: `Привет, ${customer.first_name}!` },
      footer: { text: "Выберите тип доставки и адрес" },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: `existing_customer_${Date.now()}`,
          flow_id: ORDER_FLOW_ID,
          flow_cta: "Заказать",
          flow_action: "navigate",
          flow_action_payload: {
            screen: "ORDER_TYPE",
            data: { flow_type: "existing_customer", customer_name: customer.first_name, user_addresses: addresses, branches }
          }
        }
      }
    }
  };
  await sendWhatsAppMessage(phone_no_id, flowData);
  console.log('✅ [Flow] RU Flow для существующего клиента отправлен');
}

async function sendExistingCustomerFlowKy(phone_no_id, from, customer, branches) {
  console.log('📤 [Flow] Отправка KG Flow для существующего клиента');
  const addresses = customer.addresses.map(a => ({ id: `address_${a.id}`, title: a.full_address }));
  addresses.push({ id: "new", title: "➕ Жаны дарек" });

  const flowData = {
    messaging_product: "whatsapp",
    to: from,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: "🛒 Буйрутма беруу" },
      body: { text: `Салам, ${customer.first_name}!` },
      footer: { text: "Форма толтурунуз" },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: `existing_customer_${Date.now()}`,
          flow_id: ORDER_FLOW_ID_KY,
          flow_cta: "Буйрутма беруу",
          flow_action: "navigate",
          flow_action_payload: {
            screen: "ORDER_TYPE",
            data: { flow_type: "existing_customer", customer_name: customer.first_name, user_addresses: addresses, branches }
          }
        }
      }
    }
  };
  await sendWhatsAppMessage(phone_no_id, flowData);
  console.log('✅ [Flow] KG Flow для существующего клиента отправлен');
}

// ---------------------------- Flow response handler ----------------------------
async function handleFlowResponse(phone_no_id, from, message, body_param) {
  console.log('🔄 [Flow Response] Обработка ответа от Flow');
  try {
    const flowResponse = JSON.parse(message.interactive.nfm_reply.response_json);
    console.log('📋 [Flow Response] Тип Flow:', flowResponse.flow_type);
    console.log('📋 [Flow Response] Данные:', JSON.stringify(flowResponse, null, 2));

    if (flowResponse.flow_type === 'new_customer') {
      console.log('🆕 [Flow Response] Обработка нового клиента');
      await handleNewCustomerRegistration(phone_no_id, from, flowResponse);
    } else if (flowResponse.flow_type === 'existing_customer') {
      console.log('👤 [Flow Response] Обработка существующего клиента');
      await handleExistingCustomerOrder(phone_no_id, from, flowResponse);
    } else {
      console.log('⚠️ [Flow Response] Неизвестный тип Flow');
      await sendMessage(phone_no_id, from, "Ошибка обработки flow!");
    }
  } catch (error) {
    console.error('❌ [Flow Response] Ошибка:', error.message);
    await sendMessage(phone_no_id, from, "Ошибка обработки формы. Попробуйте еще раз.");
    await clearUserWaitingState(from);
  }
}

// ---------------------------- Registration / Orders from flow ----------------------------
async function handleNewCustomerRegistration(phone_no_id, from, data) {
  console.log('🆕 [Registration] Регистрация нового клиента');
  console.log('📋 [Registration] Имя:', data.customer_name);
  console.log('📋 [Registration] Тип заказа:', data.order_type);
  
  try {
    if (data.order_type === 'delivery' && data.delivery_address) {
      console.log('📍 [Registration] Требуется геолокация для доставки');
      const userState = {
        flow_type: 'new_customer',
        customer_name: data.customer_name,
        delivery_address: data.delivery_address,
        preparation_time: data.preparation_time,
        specific_time: data.specific_time,
        utensils_count: data.utensils_count === 'custom' ? data.custom_utensils_count : data.utensils_count,
        promo_code: data.promo_code,
        comment: data.comment,
        payment_method: data.payment_method
      };
      await setUserState(from, userState);
      await setUserWaitingState(from, WAITING_STATES.LOCATION);
      await sendLocationRequest(phone_no_id, from, data.customer_name);
      console.log('✅ [Registration] Запрос геолокации отправлен');
    } else {
      console.log('🏪 [Registration] Самовывоз, регистрация без геолокации');
      await registerCustomerWithoutLocation(phone_no_id, from, data);
    }
  } catch (error) {
    console.error('❌ [Registration] Ошибка:', error.message);
    await sendMessage(phone_no_id, from, 'Ошибка при регистрации. Попробуйте позже.');
    await clearUserWaitingState(from);
  }
}

async function registerCustomerWithoutLocation(phone_no_id, from, data) {
  console.log('📝 [Registration NoLoc] Регистрация без геолокации');
  try {
    const lan = await getUserLan(from);
    console.log('📡 [API] Получение qr_token клиента...');
    const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
    const qr_token = customerResponse.data.qr_access_token;
    console.log('✅ [API] qr_token получен');

    console.log('📡 [API] Обновление данных клиента...');
    const updateData = { firstName: data.customer_name };
    await axios.post(`${TEMIR_API_BASE}/qr/update-customer/?qr_token=${qr_token}`, updateData);
    console.log('✅ [API] Данные клиента обновлены');

    let confirmText = `Спасибо за регистрацию, ${data.customer_name}! 🎉\n\nВы выбрали самовывоз.\n\nТеперь выберите блюда на нашем сайте: 🍣`;
    if (lan === 'kg') {
      confirmText = `Катталганыңыз үчүн рахмат, ${data.customer_name}! 🎉\n\nСиз алып кетүүнү тандадыңыз.\n\nЭми биздин сайттан тамактарды тандаңыз! 🍣`;
    }
    await sendMessage(phone_no_id, from, confirmText);

    await sendMenuLink(phone_no_id, from);
    console.log('✅ [Registration NoLoc] Завершено');
  } catch (error) {
    console.error('❌ [Registration NoLoc] Ошибка:', error.message);
    await sendMessage(phone_no_id, from, "Ошибка регистрации. Попробуйте еще раз.");
    await clearUserWaitingState(from);
  }
}

async function handleExistingCustomerOrder(phone_no_id, from, data) {
  console.log('👤 [Existing Order] Обработка заказа существующего клиента');
  console.log('📋 [Existing Order] Тип заказа:', data.order_type);
  console.log('📋 [Existing Order] Выбор доставки:', data.delivery_choice);
  
  try {
    const lan = await getUserLan(from);
    const userState = {
      flow_type: 'existing_customer',
      order_type: data.order_type,
      delivery_choice: data.delivery_choice,
      new_address: data.new_address,
      branch: data.branch,
      customer_name: data.customer_name,
      preparation_time: data.preparation_time,
      specific_time: data.specific_time,
      utensils_count: data.utensils_count === 'custom' ? data.custom_utensils_count : data.utensils_count,
      promo_code: data.promo_code,
      comment: data.comment,
      payment_method: data.payment_method
    };
    await setUserState(from, userState);

    if (data.order_type === 'delivery' && data.delivery_choice === 'new' && data.new_address) {
      console.log('📍 [Existing Order] Новый адрес, требуется геолокация');
      const updatedUserState = {
        ...userState,
        delivery_address: data.new_address
      };
      await setUserState(from, updatedUserState);
      await setUserWaitingState(from, WAITING_STATES.LOCATION);
      await sendLocationRequest(phone_no_id, from, data.customer_name);
      console.log('✅ [Existing Order] Запрос геолокации отправлен');
    } else {
      console.log('✅ [Existing Order] Адрес уже есть или самовывоз');
      let confirmText;
      if (data.order_type === 'delivery') {
        const title = data.user_addresses.find(a => a.id === data.delivery_choice)?.title || '';
        confirmText = lan === 'kg'
          ? `✅ Эң сонун! Заказ тандалган дарекке жеткирилет.\n\n${title}\n\nТандоону сайттан жасаңыз:`
          : `✅ Отлично! Заказ будет доставлен по выбранному адресу.\n\n${title}\n\nВыберите блюда на сайте:`;
      } else {
        const t = data.branches.find(b => b.id === data.branch)?.title || '';
        confirmText = lan === 'kg'
          ? `✅ Абдан жакшы! Сиз алып кетүүнү тандадыңыз.\n\n${t}\n\nТандоону сайттан жасаңыз:`
          : `✅ Отлично! Вы выбрали самовывоз.\n\n${t}\n\nВыберите блюда на сайте:`;
      }
      await sendMessage(phone_no_id, from, confirmText);
      await sendMenuLink(phone_no_id, from);
      console.log('✅ [Existing Order] Ссылка на меню отправлена');
    }
  } catch (error) {
    console.error('❌ [Existing Order] Ошибка:', error.message);
    await sendMessage(phone_no_id, from, 'Ошибка. Попробуйте еще раз.');
    await clearUserWaitingState(from);
  }
}

// ---------------------------- Menu link sender ----------------------------
async function sendMenuLink(phone_no_id, to) {
  console.log('🔗 [Menu Link] Отправка ссылки на меню');
  const lan = await getUserLan(to);
  const locationId = await resolveLocationId(to);
  
  if (!MENU_URL) {
    console.log('⚠️ [Menu Link] MENU_URL не настроен');
    await sendMessage(phone_no_id, to, lan === 'kg' ? 'Меню URL орнотулган эмес.' : 'URL меню не настроен.');
    return;
  }
  
  const u = new URL(MENU_URL);
  u.searchParams.set('phone', to);
  if (locationId) {
    u.searchParams.set('locationId', locationId);
    console.log('📍 [Menu Link] LocationId добавлен:', locationId);
  }

  console.log('🔗 [Menu Link] URL:', u.toString());

  const interactive = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "cta_url",
      header: { type: "text", text: lan === 'kg' ? "Абдан жакшы!" : "Отлично!" },
      body: {
        text: lan === 'kg'
          ? "Төмөндөгү баскычты басып менюну көрүп буйрутма бериңиз."
          : "Нажмите на кнопку ниже, чтобы посмотреть меню и сделать заказ."
      },
      footer: { text: "Yaposhkin Rolls" },
      action: {
        name: "cta_url",
        parameters: {
          display_text: lan === 'kg' ? "Менюну ачуу" : "Посмотреть меню",
          url: u.toString()
        }
      }
    }
  };

  await sendWhatsAppMessage(phone_no_id, interactive);
  await setResumeCheckpoint(to, { kind: 'catalog' });
  await setUserWaitingState(to, WAITING_STATES.CATALOG_ORDER);
  console.log('✅ [Menu Link] Ссылка отправлена');
}

// ---------------------------- Location flow ----------------------------
async function sendLocationRequest(phone_no_id, from, customerName) {
  console.log('📍 [Location] Запрос геолокации');
  const lan = await getUserLan(from);
  const text = lan === 'kg'
    ? `Рахмат, ${customerName}! 📍\n\nТак жеткирүү үчүн жайгашкан жериңизди бөлүшүңүз.`
    : `Спасибо, ${customerName}! 📍\n\nДля точной доставки, пожалуйста, поделитесь своим местоположением.`;
  await sendMessage(phone_no_id, from, text);
  console.log('✅ [Location] Запрос отправлен');
}

async function handleLocationMessage(phone_no_id, from, message) {
  console.log('📍 [Location] Получена геолокация');
  try {
    const { longitude, latitude } = message.location;
    console.log('🌍 [Location] Координаты:', latitude, longitude);
    
    const userState = await getUserState(from);
    if (!userState) {
      console.log('⚠️ [Location] Состояние пользователя не найдено');
      await sendMessage(phone_no_id, from, "Произошла ошибка. Попробуйте заново оформить заказ.");
      await clearUserWaitingState(from);
      return;
    }

    await updateCustomerWithLocation(phone_no_id, from, userState, longitude, latitude);
  } catch (error) {
    console.error('❌ [Location] Ошибка:', error.message);
    await sendMessage(phone_no_id, from, "Ошибка при сохранении адреса. Попробуйте еще раз.");
    await clearUserWaitingState(from);
  }
}

async function updateCustomerWithLocation(phone_no_id, from, userState, longitude, latitude) {
  console.log('📍 [Location Update] Обновление адреса клиента с геолокацией');
  const lan = await getUserLan(from);
  
  try {
    console.log('📡 [API] Получение qr_token...');
    const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
    const qr_token = customerResponse.data.qr_access_token;

    const updateData = {
      firstName: userState.customer_name,
      addresses: [{
        fullAddress: userState.delivery_address,
        office: "", floor: "", doorcode: "", entrance: "", comment: "",
        geocoding: {
          datasource: "yandex",
          longitude, latitude,
          country: "Кыргызстан", countrycode: "KG", city: "Бишкек",
          street: "", house: "", date: ""
        }
      }]
    };

    console.log('📡 [API] Обновление клиента с адресом...');
    console.log('📍 [Location Update] Адрес:', userState.delivery_address);
    await axios.post(`${TEMIR_API_BASE}/qr/update-customer/?qr_token=${qr_token}`, updateData);
    console.log('✅ [API] Клиент обновлен');

    const updatedState = {
      ...userState,
      order_type: 'delivery',
      delivery_choice: 'new',
      location_processed: true,
      new_address: userState.delivery_address
    };
    await setUserState(from, updatedState);

    let confirmText = lan === 'kg'
      ? `Катталганыңыз үчүн рахмат, ${userState.customer_name}! 🎉\n\nДарегиңиз сакталды: ${userState.delivery_address}\n\nЭми заказ берсеңиз болот. Мен сизге азыр менюнун ссылкасын жөнөтөм! 🍣`
      : `Спасибо за регистрацию, ${userState.customer_name}! 🎉\n\nВаш адрес сохранен: ${userState.delivery_address}\n\nТеперь вы можете делать заказы. Сейчас отправлю ссылку на меню! 🍣`;
    
    if (userState.flow_type !== 'new_customer') {
      confirmText = lan === 'kg'
        ? `✅ Жаңы дарек кошулду!\n\n📍 ${userState.delivery_address}\n\nЭми сайттан тандаңыз:`
        : `✅ Новый адрес добавлен!\n\n📍 ${userState.delivery_address}\n\nТеперь выберите блюда на сайте:`;
    }

    await sendMessage(phone_no_id, from, confirmText);
    await sendMenuLink(phone_no_id, from);
    console.log('✅ [Location Update] Процесс завершен');
  } catch (error) {
    console.error('❌ [Location Update] Ошибка:', error.message);
    await sendMessage(phone_no_id, from, "Произошла ошибка при сохранении данных.");
    await deleteUserState(from);
    await clearUserWaitingState(from);
  }
}

// ---------------------------- Catalog / Order ----------------------------
let productsCache = null;
let productsCacheForSection = null;

async function getAllProducts() {
  if (productsCache) {
    console.log('📦 [Products] Используется кэш продуктов');
    return productsCache;
  }
  
  console.log('📡 [API] Загрузка всех продуктов...');
  const response = await axios.get(`${TEMIR_API_BASE}/qr/products`);
  const products = response.data;
  console.log('✅ [API] Загружено продуктов:', products.length);
  
  const map = {};
  products.forEach(p => { 
    map[p.id] = { 
      id: p.id, 
      api_id: p.api_id, 
      title: p.title, 
      measure_unit: p.measure_unit_title || 'шт' 
    }; 
  });
  productsCache = map;
  return map;
}

async function getAllProductsForSections() {
  if (productsCacheForSection) {
    console.log('📦 [Products Sections] Используется кэш');
    return productsCacheForSection;
  }
  
  console.log('📡 [API] Загрузка продуктов для секций...');
  const response = await axios.get(`${TEMIR_API_BASE}/qr/products`);
  const products = response.data;
  console.log('✅ [API] Загружено продуктов для секций:', products.length);
  
  const map = {};
  products.forEach(p => { 
    map[p.api_id] = { 
      id: p.id, 
      api_id: p.api_id, 
      title: p.title 
    }; 
  });
  productsCacheForSection = map;
  return map;
}

async function getProductInfo(productId) {
  console.log('📦 [Product] Получение информации о продукте:', productId);
  const products = await getAllProducts();
  if (products[productId]) {
    console.log('✅ [Product] Найден в кэше:', products[productId].title);
    return products[productId];
  }
  
  console.log('📡 [API] Загрузка информации о продукте из API...');
  const response = await axios.get(`${TEMIR_API_BASE}/qr/products/${productId}`);
  const p = response.data;
  console.log('✅ [API] Продукт загружен:', p.title);
  return { 
    id: p.id, 
    api_id: p.api_id, 
    title: p.title, 
    measure_unit: p.measure_unit_title || 'шт' 
  };
}

async function fetchAndConvertMenuData(from) {
  console.log('📋 [Menu Data] Получение данных меню для:', from);
  try {
    const locationId = await resolveLocationId(from);
    if (!locationId) {
      console.log('⚠️ [Menu Data] LocationId не определен');
      return null;
    }

    console.log('📡 [API] Загрузка каталога для locationId:', locationId);
    const { data: apiData } = await axios.get(`${TEMIR_API_BASE}/qr/catalog?location_id=${locationId}`);
    const products = await getAllProductsForSections();

    const optimizedMenuGroups = apiData.map(group =>
      group.map(section => ({
        section_title: section.section_title,
        products: (section.products || [])
          .map(api_id => products[api_id]?.id)
          .filter(Boolean)
      }))
    );

    console.log('✅ [Menu Data] Данные меню получены');
    return optimizedMenuGroups;
  } catch (e) {
    console.error('❌ [Menu Data] Ошибка:', e.message);
    return null;
  }
}

async function resolveLocationId(from) {
  console.log('📍 [Location ID] Определение locationId для:', from);
  const userState = (await getUserState(from)) || {};
  let locationId = null;

  if (userState.order_type !== 'delivery') {
    console.log('🏪 [Location ID] Самовывоз');
    if (userState.branch) {
      console.log('🏪 [Location ID] Филиал из состояния:', userState.branch);
      const branchInfo = await getBranchInfo(String(userState.branch));
      if (branchInfo) {
        console.log('✅ [Location ID] Филиал найден:', branchInfo.title);
        return parseInt(branchInfo.id);
      }
    }
    console.log('📡 [API] Получение первого доступного ресторана...');
    const restaurants = (await axios.get(`${TEMIR_API_BASE}/qr/restaurants`)).data || [];
    if (restaurants[0]) {
      console.log('✅ [Location ID] Первый ресторан:', restaurants[0].title);
      return restaurants[0].external_id;
    }
    console.log('⚠️ [Location ID] Ресторанов не найдено, используем 1');
    return 1;
  }

  console.log('🚚 [Location ID] Доставка');
  const { data: customerData } = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
  let address = null;

  if (userState.delivery_choice === 'new' || userState.location_processed) {
    const addresses = customerData.customer.addresses || [];
    address = addresses[addresses.length - 1] || null;
    console.log('📍 [Location ID] Последний адрес клиента');
  } else if (userState.delivery_choice?.startsWith('address_')) {
    const id = parseInt(userState.delivery_choice.replace('address_', ''));
    address = (customerData.customer.addresses || []).find(a => a.id == id) || null;
    console.log('📍 [Location ID] Выбранный адрес ID:', id);
  }

  const geo = address?.geocoding_json || address?.geocoding || null;
  const lat = geo?.latitude, lon = geo?.longitude;
  
  if (!lat || !lon) {
    console.log('⚠️ [Location ID] Координаты не найдены');
    return null;
  }

  console.log('🌍 [Location ID] Координаты:', lat, lon);
  console.log('📡 [API] Запрос информации о доставке...');
  const delivery = (await axios.get(`${TEMIR_API_BASE}/qr/delivery/?lat=${lat}&lon=${lon}`)).data || [];
  if (delivery[0]?.restaurant_id) {
    locationId = delivery[0].restaurant_id;
    console.log('✅ [Location ID] Ресторан для доставки:', locationId);
  }

  return locationId || null;
}

// ---------------------------- Catalog order handler ----------------------------
async function handleCatalogOrderResponse(phone_no_id, from, message) {
  console.log('🛒 [Catalog Order] Обработка заказа из каталога');
  const lan = await getUserLan(from);
  
  try {
    const order = message.order;
    console.log('📦 [Catalog Order] Товаров в заказе:', order?.product_items?.length || 0);

    let orderSummary = lan === 'kg' ? "🛒 Сиздин буйрутмаңыз:\n\n" : "🛒 Ваш заказ:\n\n";
    let totalAmount = 0;
    const orderItems = [];

    if (order?.product_items) {
      for (let i = 0; i < order.product_items.length; i++) {
        const item = order.product_items[i];
        const productInfo = await getProductInfo(item.product_retailer_id);
        const productName = productInfo.title || `Товар ${item.product_retailer_id}`;
        const itemPrice = parseFloat(item.item_price) || 0;
        const itemTotal = itemPrice * item.quantity;

        console.log(`📦 [Catalog Order] ${i + 1}. ${productName} x${item.quantity} = ${itemTotal} KGS`);

        orderSummary += `${i + 1}. ${productName}\n`;
        orderSummary += lan === 'kg'
          ? `Даанасы: ${item.quantity} ${productInfo.measure_unit || 'шт'}\n`
          : `Количество: ${item.quantity} ${productInfo.measure_unit || 'шт'}\n`;
        orderSummary += lan === 'kg'
          ? `Баасы: ${itemPrice} KGS x ${item.quantity} = ${itemTotal} KGS\n\n`
          : `Цена: ${itemPrice} KGS x ${item.quantity} = ${itemTotal} KGS\n\n`;

        totalAmount += itemTotal;
        orderItems.push({
          id: parseInt(productInfo.api_id),
          title: productName,
          quantity: item.quantity,
          priceWithDiscount: null,
          dealDiscountId: null,
          modifierGroups: []
        });
      }
    }

    orderSummary += lan === 'kg' 
      ? `💰 Жалпы наркы: ${totalAmount} KGS\n\n` 
      : `💰 Общая стоимость: ${totalAmount} KGS\n\n`;

    console.log('💰 [Catalog Order] Итоговая сумма:', totalAmount, 'KGS');

    let userState = await getUserState(from);
    await calculateDeliveryAndSubmitOrder(phone_no_id, from, orderItems, totalAmount, orderSummary, userState);
  } catch (error) {
    console.error('❌ [Catalog Order] Ошибка:', error.message);
    await sendMessage(phone_no_id, from, "Произошла ошибка при обработке заказа. Попробуйте еще раз.");
    await clearUserWaitingState(from);
  }
}

// utils
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function getLocationWorkingHours(locationId) {
  console.log('🕐 [Working Hours] Получение часов работы для locationId:', locationId);
  try {
    const { data: restaurants } = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
    const r = restaurants.find(x => String(x.external_id) === String(locationId));
    if (!r) {
      console.log('⚠️ [Working Hours] Ресторан не найден');
      return null;
    }

    const t = r.working_hours_today || r.workingHoursToday || null;
    if (t) {
      const open = t.open || t.openTime || t.start || t.from;
      const close = t.close || t.closeTime || t.end || t.to;
      if (open && close) {
        console.log('✅ [Working Hours] Часы сегодня:', `${open} - ${close}`);
        return `${open} - ${close}`;
      }
    }

    const daysEn = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const todayKey = daysEn[new Date().getDay()];
    const wh = r.working_hours || r.workingHours || r.schedule || null;
    if (wh && wh[todayKey]) {
      const d = wh[todayKey];
      const open = d.open || d.openTime || d.start || d.from;
      const close = d.close || d.closeTime || d.end || d.to;
      if (open && close) {
        console.log('✅ [Working Hours] Часы из расписания:', `${open} - ${close}`);
        return `${open} - ${close}`;
      }
      if (typeof d === 'string') {
        console.log('✅ [Working Hours] Часы (строка):', d);
        return d;
      }
    }

    if (typeof r.working_hours === 'string') {
      console.log('✅ [Working Hours] Часы (строка):', r.working_hours);
      return r.working_hours;
    }
    if (typeof r.workingHours === 'string') {
      console.log('✅ [Working Hours] Часы (строка):', r.workingHours);
      return r.workingHours;
    }

    console.log('⚠️ [Working Hours] Используем стандартные часы');
    return "11:00 - 23:45";
  } catch (error) {
    console.error('❌ [Working Hours] Ошибка:', error.message);
    return "11:00 - 23:45";
  }
}

// ---------------------------- Delivery calc + submit ----------------------------
async function calculateDeliveryAndSubmitOrder(phone_no_id, from, orderItems, totalAmount, orderSummary, paramUserState) {
  console.log('💰 [Delivery Calc] Расчет доставки и оформление заказа');
  console.log('📦 [Delivery Calc] Товаров:', orderItems.length);
  console.log('💰 [Delivery Calc] Сумма товаров:', totalAmount, 'KGS');
  
  const lan = await getUserLan(from);

  let deliveryCost = 0;
  let locationId = null;
  let locationTitle = "";
  let orderType = "pickup";
  let deliveryAddress = "";
  let utensils_count;

  try {
    let userState = paramUserState;
    if (!userState) {
      console.log('⚠️ [Delivery Calc] Состояние не передано, загружаем из БД');
      userState = await getUserState(from);
    }
    if (!userState) {
      console.log('⚠️ [Delivery Calc] Состояние отсутствует, используем fallback');
      userState = { order_type: 'pickup', flow_type: 'fallback' };
    }

    console.log('📡 [API] Получение данных клиента...');
    const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
    const customerData = customerResponse.data;

    orderType = userState.order_type || "pickup";
    utensils_count = userState.utensils_count;
    console.log('📋 [Delivery Calc] Тип заказа:', orderType);
    console.log('🍴 [Delivery Calc] Количество приборов:', utensils_count);

    if (orderType === 'delivery') {
      console.log('🚚 [Delivery Calc] Обработка доставки');
      let address = null;
      let tempLat = null;
      let tempLon = null;

      if (userState.delivery_choice === 'new' || userState.location_processed) {
        const addresses = customerData.customer.addresses || [];
        address = addresses[addresses.length - 1];
        deliveryAddress = userState.new_address || userState.delivery_address || address?.full_address || "";
        console.log('📍 [Delivery Calc] Новый/последний адрес:', deliveryAddress);
        if (address?.geocoding_json) {
          tempLat = address.geocoding_json.latitude;
          tempLon = address.geocoding_json.longitude;
        }
      } else {
        const addressIndex = parseInt(userState.delivery_choice.replace('address_', ''));
        address = customerData.customer.addresses.find(item => item.id == addressIndex);
        deliveryAddress = address?.full_address || "";
        console.log('📍 [Delivery Calc] Выбранный адрес ID:', addressIndex, '-', deliveryAddress);
        if (address?.geocoding_json) {
          tempLat = address.geocoding_json.latitude;
          tempLon = address.geocoding_json.longitude;
        }
      }

      if (!tempLat || !tempLon) {
        console.log('❌ [Delivery Calc] Координаты отсутствуют');
        await sendMessage(phone_no_id, from, "❌ Не удается определить координаты адреса доставки.");
        await deleteUserState(from);
        await clearUserWaitingState(from);
        return;
      }

      console.log('🌍 [Delivery Calc] Координаты:', tempLat, tempLon);
      console.log('📡 [API] Запрос стоимости доставки...');

      try {
        const deliveryResponse = await axios.get(`${TEMIR_API_BASE}/qr/delivery/?lat=${tempLat}&lon=${tempLon}`);
        if (deliveryResponse.data[0]) {
          deliveryCost = deliveryResponse.data[0].delivery_cost || 0;
          locationId = deliveryResponse.data[0].restaurant_id;
          locationTitle = deliveryResponse.data[0].title || "Ресторан";
          console.log('✅ [Delivery Calc] Стоимость доставки:', deliveryCost, 'KGS');
          console.log('✅ [Delivery Calc] Ресторан:', locationTitle, '(ID:', locationId + ')');
        } else {
          console.log('❌ [Delivery Calc] Доставка недоступна');
          await sendMessage(phone_no_id, from, "❌ Доставка по этому адресу недоступна.");
          await deleteUserState(from);
          await clearUserWaitingState(from);
          return;
        }
      } catch (deliveryError) {
        console.error('❌ [Delivery Calc] Ошибка API доставки:', deliveryError.message);
        await sendMessage(phone_no_id, from, "❌ Ошибка при расчете доставки.");
        await deleteUserState(from);
        await clearUserWaitingState(from);
        return;
      }
    } else {
      console.log('🏪 [Delivery Calc] Самовывоз');
      if (userState?.branch) {
        console.log('🏪 [Delivery Calc] Филиал из состояния:', userState.branch);
        const branchInfo = await getBranchInfo(userState.branch);
        if (branchInfo) {
          locationId = parseInt(userState.branch);
          locationTitle = branchInfo.title;
          console.log('✅ [Delivery Calc] Филиал:', locationTitle);
        } else {
          console.log('❌ [Delivery Calc] Филиал недоступен');
          await sendMessage(phone_no_id, from, `❌ Ошибка: выбранный филиал недоступен. Обратитесь к менеджеру ${contact_branch['1']}.`);
          await deleteUserState(from);
          await clearUserWaitingState(from);
          return;
        }
      } else {
        console.log('📡 [API] Получение первого доступного филиала...');
        const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
        const restaurants = restaurantsResponse.data;
        if (restaurants.length > 0) {
          const selectedBranch = restaurants[0];
          locationId = selectedBranch.external_id;
          locationTitle = selectedBranch.title;
          console.log('✅ [Delivery Calc] Первый филиал:', locationTitle);
        } else {
          console.log('❌ [Delivery Calc] Нет доступных филиалов');
          await sendMessage(phone_no_id, from, `❌ Нет доступных филиалов. Обратитесь к менеджеру ${contact_branch['1']}.`);
          await deleteUserState(from);
          await clearUserWaitingState(from);
          return;
        }
      }
    }

    if (!locationId) {
      console.log('❌ [Delivery Calc] LocationId не определен');
      await sendMessage(phone_no_id, from, "❌ Ошибка определения места выполнения заказа.");
      await deleteUserState(from);
      await clearUserWaitingState(from);
      return;
    }

    const finalAmount = totalAmount + deliveryCost;
    console.log('💰 [Delivery Calc] Итоговая сумма с доставкой:', finalAmount, 'KGS');
    
    let costMessage = orderSummary;

    if (orderType === "delivery") {
      costMessage += lan === 'kg' 
        ? `🚚 Жеткирүү баасы: ${deliveryCost} KGS\n` 
        : `🚚 Стоимость доставки: ${deliveryCost} KGS\n`;
      costMessage += lan === 'kg' 
        ? `📍 Жеткирүү дареги: ${deliveryAddress}\n\n` 
        : `📍 Адрес доставки: ${deliveryAddress}\n\n`;
    } else {
      costMessage += lan === 'kg' 
        ? `🏪 Алып кетүү: 0 сом\n` 
        : `🏪 Самовывоз: 0 KGS\n`;
      costMessage += `📍 Филиал: ${locationTitle}\n\n`;
    }

    if (userState.payment_method === 'transfer') {
      costMessage += lan === 'kg' 
        ? `💳 Төлөө ыкмасы: Которуу\n` 
        : `💳 Способ оплаты: Перевод\n`;
    } else {
      costMessage += lan === 'kg' 
        ? `💵 Төлөө ыкмасы: Жеткирүү боюнча накталай акча\n\n` 
        : `💵 Способ оплаты: Наличными при получении\n\n`;
    }

    if (userState.preparation_time === 'specific' && userState.specific_time) {
      costMessage += lan === 'kg' 
        ? `⏰ Бышыруу убактысы: ${userState.specific_time}\n` 
        : `⏰ Время приготовления: ${userState.specific_time}\n`;
    } else {
      costMessage += lan === 'kg' 
        ? `⏰ Даярдоо убактысы: мүмкүн болушунча тезирээк\n` 
        : `⏰ Время приготовления: как можно скорее\n`;
    }

    if (userState.promo_code) costMessage += `🎫 Промокод: ${userState.promo_code}\n`;
    if (userState.comment) costMessage += `📝 Комментарий: ${userState.comment}\n`;

    costMessage += lan === 'kg' 
      ? `💰 Жалпы наркы: ${finalAmount} сом\n\n` 
      : `💰 Общая стоимость: ${finalAmount} KGS\n\n`;
    
    if (userState.payment_method === 'transfer') {
      costMessage += lan === 'kg' 
        ? `💳 Төлөө ыкмасы: Которуу, QR кодун жөнөтүү...\n` 
        : `💳 Способ оплаты: Перевод, отправка QR кода...\n`;
    } else {
      costMessage += lan === 'kg' 
        ? `⏳ Буйрутмаңыз иштетилүүдө...` 
        : `⏳ Оформляем ваш заказ...`;
    }

    console.log('📤 [Delivery Calc] Отправка сводки заказа');
    await sendMessage(phone_no_id, from, costMessage);

    if (userState.payment_method === 'transfer') {
      console.log('💳 [Delivery Calc] Оплата переводом, сохранение заказа');
      const userOrders = { orderItems, customerData, locationId, locationTitle, orderType, finalAmount };
      await setUserOrder(from, userOrders);
      await sendPaymentQRCodeImproved(phone_no_id, from, finalAmount);
    }

    console.log('📋 [Delivery Calc] Отправка заказа в API...');
    await submitOrder(phone_no_id, from, orderItems, customerData, locationId, locationTitle, orderType, finalAmount, utensils_count);
  } catch (error) {
    console.error('❌ [Delivery Calc] Общая ошибка:', error.message);
    console.error('❌ [Delivery Calc] Stack:', error.stack);
    
    const desc = (error.response?.data?.error?.description || "").toLowerCase();
    const type = (error.response?.data?.error?.type || "").toLowerCase();
    const status = error.response?.status;

    const { code, minAmount } = classifyPreorderError(error);
    const t = (ru, kg) => (lan === 'ru') ? ru : kg;
    const itemsAmount = totalAmount || 0;

    console.log('🔍 [Error] Тип ошибки:', code || 'UNKNOWN');
    console.log('🔍 [Error] HTTP статус:', status);

    if (code === ERR.MIN_AMOUNT) {
      console.log('⚠️ [Error] Минимальная сумма не достигнута');
      const need = (minAmount && itemsAmount) ? Math.max(minAmount - itemsAmount, 0) : null;
      let msg = t('❌ Для доставки не хватает суммы заказа.\n\n', '❌ Жеткируу үчүн сумма жетишсиз.\n\n');
      if (minAmount) msg += t(`Минимум для доставки: ${minAmount} KGS\n`, `Жеткируу минималдуу: ${minAmount} KGS\n`);
      if (need) msg += t(`Не хватает: ${need} KGS\n\n`, `Жетпейт: ${need} KGS\n\n`);
      msg += t('Добавьте блюда в корзину или выберите самовывоз.',
               'Дагы тамак кошуңуз же өзү алып кетүүнү тандаңыз.');
      await sendMessage(phone_no_id, from, msg);
      await sendMenuLink(phone_no_id, from);
      await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
      return;
    }

    if (desc.includes("location is closed") || type === "locationisclosedexception") {
      console.log('⏰ [Error] Филиал закрыт');
      const hours = await getLocationWorkingHours(locationId);
      let msg;
      if (lan === "kg") {
        msg = `⏰ Тилекке каршы, азыр ${orderType === "delivery" ? "жеткирүү" : "өзү алып кетүү"} мүмкүн эмес.\n` +
              `🏪 "${locationTitle}" филиалы жабык.\n` +
              (hours ? `🕐 Иш убактысы: ${hours}\n\n` : "\n") +
              `Иш убактысында заказ бере аласыз.`;
      } else {
        msg = `⏰ К сожалению, сейчас ${orderType === "delivery" ? "доставка" : "самовывоз"} недоступен.\n` +
              `🏪 Филиал "${locationTitle}" закрыт.\n` +
              (hours ? `🕐 Режим работы: ${hours}\n\n` : "\n") +
              `Вы можете оформить заказ в рабочее время.`;
      }
      await sendMessage(phone_no_id, from, msg);
      await deleteUserState(from);
      await clearUserWaitingState(from);
      return;
    }

    if (desc.includes("out of stock") || desc.includes("unavailable") || type === "soldoutproductexception") {
      console.log('📦 [Error] Товары недоступны');
      const ids = error.response?.data?.error?.productIds || [];
      const unavailable = ids
        .map(pid => orderItems.find(o => o.id === pid)?.title)
        .filter(Boolean)
        .join("\n");

      let msg;
      if (lan === "kg") {
        msg = `❌ Тилекке каршы, айрым товарлар азыр жок.\n\n` +
              (unavailable ? `${unavailable}\n\n` : "") +
              `Сайттагы менюдан альтернатива тандаңыз же менеджерге кайрылыңыз.`;
      } else {
        msg = `❌ К сожалению, некоторые позиции сейчас недоступны.\n\n` +
              (unavailable ? `${unavailable}\n\n` : "") +
              `Выберите альтернативы на сайте меню или свяжитесь с менеджером.`;
      }
      await sendMessage(phone_no_id, from, msg);
      await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
      await sendMenuLink(phone_no_id, from);
      return;
    }

    if (status === 400) {
      console.log('❌ [Error] HTTP 400 - Неверные данные');
      await sendMessage(
        phone_no_id,
        from,
        lan === "kg"
          ? "❌ Заказ маалыматтарында ката. Кайра берип көрүңүз."
          : "❌ Ошибка в данных заказа. Попробуйте оформить заново."
      );
    } else if (status === 404) {
      console.log('❌ [Error] HTTP 404 - Ресурс не найден');
      await sendMessage(
        phone_no_id,
        from,
        lan === "kg"
          ? "❌ Тандалган филиал жеткиликсиз. Кийинчерээк аракет кылыңыз."
          : "❌ Выбранный филиал недоступен. Попробуйте позже."
      );
    } else if (status === 500) {
      console.log('❌ [Error] HTTP 500 - Серверная ошибка');
      await sendMessage(
        phone_no_id,
        from,
        lan === "kg"
          ? "❌ Серверде техникалык көйгөйлөр. Бир аздан кийин аракет кылыңыз."
          : "❌ Технические неполадки на сервере. Повторите попытку позже."
      );
    } else {
      console.log('❌ [Error] Неизвестная ошибка');
      const txt = error.response?.data?.error?.description || error.message || "Unknown error";
      await sendMessage(
        phone_no_id,
        from,
        lan === "kg"
          ? `❌ Заказ берүүдө ката: ${txt}`
          : `❌ Ошибка оформления заказа: ${txt}`
      );
    }
    await deleteUserState(from);
    await deleteUserOrders(from);
    await clearUserWaitingState(from);
  }
}

// Классификация ошибок preorder (MIN_AMOUNT)
function classifyPreorderError(error) {
  const data = error?.response?.data || {};
  const e = data.error || {};
  const type = String(e.type || '').toUpperCase();
  const desc = String(e.description || data.message || '').toLowerCase();

  let code = null, minAmount = e.minOrderAmount || e.minOrderSum || null;

  if (type.includes('DELIVERYNOTAVAILABLEFORAMOUNTEXCEPTION') ||
      desc.includes('not available for amount')) {
    code = ERR.MIN_AMOUNT;
    console.log('⚠️ [Error Classification] MIN_AMOUNT обнаружен');
  }

  if (!minAmount) {
    const m = /(min(?:imum)?\s*(?:order)?\s*(?:sum|amount)\D+(\d+))/i.exec(e.description || '');
    if (m) {
      minAmount = Number(m[2]);
      console.log('⚠️ [Error Classification] minAmount извлечен из описания:', minAmount);
    }
  }

  return { code, minAmount, description: e.description || '' };
}

// ---------------------------- Payment QR ----------------------------
async function sendPaymentQRCodeImproved(phone_no_id, to, amount) {
  console.log('💳 [Payment] Отправка QR кода для оплаты');
  console.log('💰 [Payment] Сумма:', amount, 'KGS');
  
  const lan = await getUserLan(to);
  try {
    const qrImageUrl = "https://yaposhkinrolls.com/image-proxy-new/460x460,q85,spFLp372BcVbVX3LkpozjsUzn_ZkOP_vM1B6xzIL8Ey4/https://storage.yandexcloud.net/quickrestobase/ve738/offer/681b464f-8e8d-4b5e-b96a-c2628eaf7a52.png";
    const paymentPhone = "+996709063676";
    const paymentRecipient = "ЭМИРЛАН Э.";

    const imageMessage = {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: {
        link: qrImageUrl,
        caption: lan === 'kg'
          ? `💳 Төлөө үчүн QR коду\n\n💰 Төлөө турган сумма: ${amount} KGS\n📱 ${paymentPhone}\n👤 ${paymentRecipient}\n`
          : `💳 QR код для оплаты\n\n💰 Сумма к оплате: ${amount} KGS\n📱 ${paymentPhone}\n👤 ${paymentRecipient}\n`
      }
    };
    await sendWhatsAppMessage(phone_no_id, imageMessage);
    console.log('✅ [Payment] QR код отправлен');
  } catch (error) {
    console.error('❌ [Payment] Ошибка отправки QR:', error.message);
    console.log('🔄 [Payment] Отправка текстовой информации (fallback)');
    
    const paymentPhone = "+996709063676";
    const paymentRecipient = "ЭМИРЛАН Э.";
    const fallbackMessage = lan === 'kg'
      ? `💳 Которуу аркылуу төлөө:\n\n📱 ${paymentPhone}\n👤 ${paymentRecipient}\n\n💰 Төлөнө турган сумма: ${amount} KGS\n`
      : `💳 Оплата переводом:\n\n📱 ${paymentPhone}\n👤 ${paymentRecipient}\n\n💰 Сумма к оплате: ${amount} KGS\n`;
    await sendMessage(phone_no_id, to, fallbackMessage);
    console.log('✅ [Payment] Текстовая информация отправлена');
  }
}

function computeOrderDueDateDeltaMinutes(state) {
  console.log('⏰ [Order Time] Вычисление времени приготовления');
  
  if (!state) {
    console.log('⏰ [Order Time] Состояние отсутствует, ASAP');
    return 0;
  }
  
  if (state.preparation_time === 'specific' && state.specific_time) {
    console.log('⏰ [Order Time] Указано конкретное время:', state.specific_time);
    
    const [hh, mm] = String(state.specific_time).split(':').map(Number);
    
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
      console.log('⚠️ [Order Time] Неверный формат времени, ASAP');
      return 0;
    }

    // ВАЖНО: Принудительно используем время Бишкека
    const nowUTC = new Date();
    const bishkekOffset = 6 * 60; // UTC+6 в минутах
    const nowBishkek = new Date(nowUTC.getTime() + bishkekOffset * 60000);
    
    const dueBishkek = new Date(nowBishkek);
    dueBishkek.setUTCHours(hh, mm, 0, 0);
    
    const currentHours = nowBishkek.getUTCHours();
    const currentMinutes = nowBishkek.getUTCMinutes();
    
    console.log('🕐 [Order Time] ТЕКУЩЕЕ время (UTC):', nowUTC.toISOString());
    console.log('🕐 [Order Time] ТЕКУЩЕЕ время (Бишкек):', 
                `${currentHours.toString().padStart(2, '0')}:${currentMinutes.toString().padStart(2, '0')}`);
    console.log('🕐 [Order Time] ЖЕЛАЕМОЕ время:', `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`);
    
    let deltaMs = dueBishkek - nowBishkek;
    
    if (deltaMs < 0) {
      deltaMs += 24 * 60 * 60 * 1000;
      console.log('📅 [Order Time] Заказ на следующий день');
    }
    
    const minutes = Math.round(deltaMs / 60000);
    console.log('✅ [Order Time] Разница:', minutes, 'минут', 'temp:', minutes*60);
    
    return minutes*60;
  }
  
  console.log('⏰ [Order Time] ASAP');
  return 0;
}

// ---------------------------- Submit order ----------------------------
async function submitOrder(phone_no_id, from, orderItems, customerData, locationId, locationTitle, orderType, finalAmount, utensils_count) {
  console.log('📋 [Submit Order] Отправка заказа в систему');
  console.log('📋 [Submit Order] LocationId:', locationId, '-', locationTitle);
  console.log('📋 [Submit Order] Тип:', orderType);
  console.log('💰 [Submit Order] Сумма:', finalAmount, 'KGS');
  
  const lan = await getUserLan(from);
  
  try {
    const state = await getUserState(from);

    const firstName =
      (customerData?.customer?.first_name && customerData.customer.first_name !== 'Имя'
        ? customerData.customer.first_name
        : state?.customer_name) || 'Гость';

    console.log('👤 [Submit Order] Имя клиента:', firstName);

    const orderDueDateDelta = computeOrderDueDateDeltaMinutes(state);

    const commentParts = [];
    if (state?.comment) commentParts.push(state.comment);
    if (utensils_count && utensils_count !== '0') commentParts.push(`Количество приборов: ${utensils_count}`);
    const comment = commentParts.join('\n') || '';
    
    if (comment) console.log('📝 [Submit Order] Комментарий:', comment);

    const preorderData = {
      locationId: parseInt(locationId),
      locationTitle,
      type: orderType,
      customerContact: {
        firstName,
        comment,
        contactMethod: { type: "phoneNumber", value: from }
      },
      orderDueDateDelta,
      guests: [{ orderItems }],
      paymentSumWithDiscount: null
    };

    console.log('📤 [Submit Order] Данные заказа:');
    console.log(JSON.stringify(preorderData, null, 2));

    console.log('📡 [API] Отправка preorder запроса...');
    const preorderResponse = await axios.post(
      `${TEMIR_API_BASE}/qr/preorder/?qr_token=${customerData.qr_access_token}`, 
      preorderData
    );

    console.log('✅ [API] Ответ получен:', preorderResponse.data?.status || 'unknown');

    if (preorderResponse.data?.error) {
      console.error('❌ [Submit Order] Ошибка в ответе API:', preorderResponse.data.error);
      throw { response: { status: 200, data: preorderResponse.data } };
    }

    console.log('🎉 [Submit Order] Заказ успешно оформлен');
    await sendOrderSuccessMessage(phone_no_id, from, preorderResponse.data, orderType, finalAmount, locationTitle, locationId);
  } catch (error) {
    console.error('❌ [Submit Order] Ошибка оформления:', error.message);
    
    const desc = (error.response?.data?.error?.description || "").toLowerCase();
    const type = (error.response?.data?.error?.type || "").toLowerCase();
    const status = error.response?.status;

    console.log('🔍 [Submit Order Error] Описание:', desc);
    console.log('🔍 [Submit Order Error] Тип:', type);
    console.log('🔍 [Submit Order Error] Статус:', status);

    if (desc.includes("location is closed") || type === "locationisclosedexception") {
      console.log('⏰ [Submit Order Error] Филиал закрыт');
      const hours = await getLocationWorkingHours(locationId);
      let msg;
      if (lan === "kg") {
        msg = `⏰ Тилекке каршы, азыр ${orderType === "delivery" ? "жеткирүү" : "өзү алып кетүү"} мүмкүн эмес.\n` +
              `🏪 "${locationTitle}" филиалы жабык.\n` +
              (hours ? `🕐 Иш убактысы: ${hours}\n\n` : "\n") +
              `Иш убактысында заказ бере аласыз.`;
      } else {
        msg = `⏰ К сожалению, сейчас ${orderType === "delivery" ? "доставка" : "самовывоз"} недоступен.\n` +
              `🏪 Филиал "${locationTitle}" закрыт.\n` +
              (hours ? `🕐 Режим работы: ${hours}\n\n` : "\n") +
              `Вы можете оформить заказ в рабочее время.`;
      }
      await sendMessage(phone_no_id, from, msg);
      await deleteUserState(from);
      await clearUserWaitingState(from);
      return;
    }

    if (desc.includes("out of stock") || desc.includes("unavailable") || type === "soldoutproductexception") {
      console.log('📦 [Submit Order Error] Товары недоступны');
      const ids = error.response?.data?.error?.productIds || [];
      const unavailable = ids
        .map(pid => orderItems.find(o => o.id === pid)?.title)
        .filter(Boolean)
        .join("\n");

      let msg;
      if (lan === "kg") {
        msg = `❌ Тилекке каршы, айрым товарлар азыр жок.\n\n` +
              (unavailable ? `${unavailable}\n\n` : "") +
              `Сайттагы менюдан башка тамактарды тандаңыз же менеджерге кайрылыңыз.`;
      } else {
        msg = `❌ К сожалению, некоторые позиции сейчас недоступны.\n\n` +
              (unavailable ? `${unavailable}\n\n` : "") +
              `Выберите альтернативы на сайте меню или свяжитесь с менеджером.`;
      }
      await sendMessage(phone_no_id, from, msg);
      await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
      await sendMenuLink(phone_no_id, from);
      return;
    }

    if (status === 400) {
      console.log('❌ [Submit Order Error] HTTP 400');
      await sendMessage(
        phone_no_id,
        from,
        lan === "kg"
          ? "❌ Заказ маалыматтарында ката. Кайра берип көрүңүз."
          : "❌ Ошибка в данных заказа. Попробуйте оформить заново."
      );
    } else if (status === 404) {
      console.log('❌ [Submit Order Error] HTTP 404');
      await sendMessage(
        phone_no_id,
        from,
        lan === "kg"
          ? "❌ Тандалган филиал жеткиликсиз. Кийинчерээк аракет кылыңыз."
          : "❌ Выбранный филиал недоступен. Попробуйте позже."
      );
    } else if (status === 500) {
      console.log('❌ [Submit Order Error] HTTP 500');
      await sendMessage(
        phone_no_id,
        from,
        lan === "kg"
          ? "❌ Серверде техникалык көйгөйлөр. Бир аздан кийин аракет кылыңыз."
          : "❌ Технические неполадки на сервере. Повторите попытку позже."
      );
    } else {
      console.log('❌ [Submit Order Error] Общая ошибка');
      const txt = error.response?.data?.error?.description || error.message || "Unknown error";
      await sendMessage(
        phone_no_id,
        from,
        lan === "kg"
          ? `❌ Заказ берүүдө ката: ${txt}`
          : `❌ Ошибка оформления заказа: ${txt}`
      );
    }

    await deleteUserState(from);
    await clearUserWaitingState(from);
  }
}

// ---------------------------- Branch info ----------------------------
async function getBranchInfo(branchId) {
  console.log('🏪 [Branch Info] Получение информации о филиале:', branchId);
  try {
    const response = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
    const restaurants = response.data;
    const branch = restaurants.find(r => r.external_id.toString() === branchId);
    if (branch) {
      console.log('✅ [Branch Info] Филиал найден:', branch.title);
      return {
        id: branch.external_id,
        title: branch.title,
        address: branch.address,
        phone: branch.contacts.find(c => c.type === 'PHONE')?.value,
        whatsapp: branch.contacts.find(c => c.type === 'WHATSAPP')?.value
      };
    }
    console.log('⚠️ [Branch Info] Филиал не найден');
    return null;
  } catch (error) {
    console.error('❌ [Branch Info] Ошибка:', error.message);
    return null;
  }
}

// ---------------------------- Simple answers ----------------------------
async function sendOrderStatusResponse(phone_no_id, from, language) {
  console.log('📊 [Response] Отправка информации о статусе заказа');
  const m = language === 'kg'
    ? `📋 Буйрутмаңыздын статусу жөнүндө:\n\nСиздин WhatsApp'ка буйрутмаңыздын статусу жөнүндө билдирүү жөнөтүлөт.`
    : `📋 О статусе заказа:\n\nВам будет отправлено уведомление в WhatsApp о статусе заказа.`;
  await sendMessage(phone_no_id, from, m);
}

async function sendOrderTrackingResponse(phone_no_id, from, language) {
  console.log('🔍 [Response] Отправка информации об отслеживании');
  const m = language === 'kg'
    ? `📱 Буйрутманы көзөмөлдөө:\n\nСиздин WhatsApp'ка буйрутмаңыздын статусу жөнүндө билдирүү жөнөтүлөт.`
    : `📱 Отслеживание заказа:\n\nВам будет отправлено уведомление в WhatsApp о статусе заказа.`;
  await sendMessage(phone_no_id, from, m);
}

async function sendPickupAddressResponse(phone_no_id, from, language) {
  console.log('📍 [Response] Отправка адресов самовывоза');
  const m = language === 'kg'
    ? `📍 Алып кетүү дареги:\n\n🏪 **Yaposhkin Rolls**\nИсы Ахунбаева 125в\nБишкек, көчөсү Исы Ахунбаева, 125А\n📞 +996709063676\n🕐 Күн сайын 11:00 - 23:45\n\n🏪 **Yaposhkin Rolls Кок жар**\nБишкек, көчөсү Чар, 83\n📞 +996705063676\n🕐 Күн сайын 11:00 - 23:45`
    : `📍 Адреса для самовывоза:\n\n🏪 **Yaposhkin Rolls**\nИсы Ахунбаева 125в\nБишкек, улица Исы Ахунбаева, 125А\n📞 +996709063676\n🕐 Ежедневно 11:00 - 23:45\n\n🏪 **Yaposhkin Rolls Кок жар**\nБишкек, улица Чар, 83\n📞 +996705063676\n🕐 Ежедневно 11:00 - 23:45`;
  await sendMessage(phone_no_id, from, m);
}

async function sendMenuResponse(phone_no_id, from, language) {
  console.log('🍽️ [Response] Отправка меню');
  try {
    let textMessage = language === 'kg' ? `🍽️ Биздин толук меню:` : `🍽️ Наше полное меню:`;
    await sendMessage(phone_no_id, from, textMessage);

    const possiblePaths = [
      './assets/menu.pdf',
      '/var/task/assets/menu.pdf',
      path.join(__dirname, 'assets', 'menu.pdf'),
      path.join(process.cwd(), 'assets', 'menu.pdf')
    ];

    let menuPdfPath = null;
    for (const p of possiblePaths) {
      console.log('📁 [Menu PDF] Проверка пути:', p);
      if (fs.existsSync(p)) { 
        menuPdfPath = p; 
        console.log('✅ [Menu PDF] Файл найден:', p);
        break; 
      }
    }
    
    if (!menuPdfPath) {
      console.log('⚠️ [Menu PDF] PDF файл не найден');
      throw new Error('PDF not found');
    }

    console.log('📤 [Menu PDF] Отправка PDF документа...');
    await sendLocalPdfDocument(phone_no_id, from, menuPdfPath, {
      document: {
        filename: language === 'kg' ? "Yaposhkin_Rolls_Menu_KG.pdf" : "Yaposhkin_Rolls_Menu_RU.pdf",
        caption: language === 'kg' ? "📋 Yaposhkin Rolls меню" : "📋 Меню Yaposhkin Rolls"
      }
    });
    console.log('✅ [Menu PDF] PDF отправлен');
  } catch (error) {
    console.error('❌ [Menu PDF] Ошибка:', error.message);
    console.log('🔄 [Menu PDF] Отправка текстового меню (fallback)');
    
    const fallbackMessage = language === 'kg'
      ? `🍽️ Биздин менюда бар:\n\n🍣 Роллдор жана суши\n🍱 Сеттер\n🥗 Салаттар\n🍜 Ысык тамактар\n🥤 Суусундуктар\n\nТолук маалымат үчүн менеджер:\n📞 +996709063676`
      : `🍽️ В нашем меню есть:\n\n🍣 Роллы и суши\n🍱 Сеты\n🥗 Салаты\n🍜 Горячие блюда\n🥤 Напитки\n\nПолная информация у менеджера:\n📞 +996709063676`;
    await sendMessage(phone_no_id, from, fallbackMessage);
  }
}

async function sendLocalPdfDocument(phone_no_id, from, filePath, documentMessage) {
  console.log('📄 [PDF Upload] Загрузка PDF файла в WhatsApp');
  try {
    const FormData = require('form-data');
    const formData = new FormData();
    const fileStream = fs.createReadStream(filePath);

    formData.append('file', fileStream, {
      filename: documentMessage.document.filename,
      contentType: 'application/pdf'
    });
    formData.append('type', 'application/pdf');
    formData.append('messaging_product', 'whatsapp');

    console.log('📡 [PDF Upload] Загрузка в WhatsApp Media API...');
    const uploadResponse = await axios.post(
      `https://graph.facebook.com/v22.0/${phone_no_id}/media`,
      formData,
      { 
        headers: { 
          'Authorization': `Bearer ${token}`, 
          ...formData.getHeaders() 
        }, 
        maxContentLength: Infinity, 
        maxBodyLength: Infinity 
      }
    );

    const mediaId = uploadResponse.data.id;
    console.log('✅ [PDF Upload] Media ID получен:', mediaId);

    const data = {
      messaging_product: "whatsapp",
      to: from,
      type: "document",
      document: { 
        id: mediaId, 
        filename: documentMessage.document.filename, 
        caption: documentMessage.document.caption 
      }
    };
    
    console.log('📤 [PDF Upload] Отправка документа пользователю...');
    await sendWhatsAppMessage(phone_no_id, data);
    console.log('✅ [PDF Upload] Документ отправлен');
  } catch (error) {
    console.error('❌ [PDF Upload] Ошибка:', error.message);
    console.log('🔄 [PDF Upload] Отправка ссылки на меню (fallback)');
    await sendMessage(phone_no_id, from, "Не удалось отправить меню. Откроем сайт меню:");
    await sendMenuLink(phone_no_id, from);
  }
}

async function sendOrderForAnotherResponse(phone_no_id, from, language) {
  console.log('👥 [Response] Информация о заказе на другого');
  const m = language === 'kg'
    ? `👥 Башка адамга буйрутма берүү:\n\nСиз башка адамга буйрутма бере аласыз, анын аты-жөнүн жана номерин көрсөтүп. Ошондой эле, жеткирүү дарегин жазууну унутпаңыз.`
    : `👥 Заказ на другого человека:\n\nМожно оформить заказ на другого, указав его имя и номер. Также не забудьте вписать нужный адрес доставки (если не самовывоз).`;
  await sendMessage(phone_no_id, from, m);
}

async function sendPaymentMethodResponse(phone_no_id, from, language) {
  console.log('💳 [Response] Информация об оплате');
  const m = language === 'kg'
    ? `💳 Төлөө жолдору:\n\nОоба, карта менен төлөсө болот.`
    : `💳 Способы оплаты:\n\nДа, можно оплатить картой.`;
  await sendMessage(phone_no_id, from, m);
}

async function sendManagerContactMessage(phone_no_id, from, language) {
  console.log('📞 [Response] Отправка контакта менеджера');
  const m = language === 'kg'
    ? `Саламатсызбы!\n\nБул суроолор боюнча биздин кызматкер менен байланышсаңыз болот:\n📱 +996709063676`
    : `Здравствуйте!\n\nПо этим вопросам можно связаться с нашим сотрудником:\n📱 +996709063676`;
  await sendMessage(phone_no_id, from, m);
}

// ---------------------------- Order success ----------------------------
async function sendOrderSuccessMessage(phone_no_id, from, preorderResponse, orderType, finalAmount, locationTitle, locationId) {
  console.log('🎉 [Order Success] Отправка сообщения об успешном заказе');
  const lan = await getUserLan(from);
  
  try {
    let successMessage = '';
    if (preorderResponse.status === 'success') {
      console.log('✅ [Order Success] Статус: SUCCESS');
      successMessage = lan === 'kg'
        ? '🎉 Буйрутмаңыз кабыл алынды!\n\n'
        : '🎉 Ваш заказ принят!\n\n';

      if (orderType === 'pickup') {
        successMessage += lan === 'kg' ? `🏪 Алуучу филиал:\n` : `🏪 Самовывоз из филиала:\n`;
        successMessage += `📍 ${locationTitle}\n`;
      } else {
        successMessage += lan === 'kg' ? `🚗 Дарегиңиз боюнча жеткирүү\n` : `🚗 Доставка по вашему адресу\n`;
      }

      successMessage += lan === 'kg'
        ? `💰 Төлөө турган сумма: ${finalAmount} сом\n\n`
        : `💰 Сумма к оплате: ${finalAmount} KGS\n\n`;

      successMessage += lan === 'kg'
        ? '⏳ Буйрутмаңыз даяр болгондо билдирүү келет.\n\n'
        : '⏳ Ожидайте уведомления о статусе заказа.\n\n';

      successMessage += lan === 'kg'
        ? `📞 Суроолоруңуз болсо: ${contact_branch[locationId]}.`
        : `📞 Вопросы: ${contact_branch[locationId]}.`;

      await setUserWaitingState(from, WAITING_STATES.ORDER_STATUS);
      console.log('✅ [Order Success] Waiting state установлен: ORDER_STATUS');
    } else {
      console.log('⚠️ [Order Success] Статус НЕ success');
      successMessage = lan === 'kg'
        ? '❌ Буйрутма берүүдө ката кетти.\n'
        : '❌ Произошла ошибка при оформлении заказа.\n';
      successMessage += lan === 'kg'
        ? `Менеджер: ${contact_branch[locationId]}`
        : `Менеджер: ${contact_branch[locationId]}`;
      await deleteUserState(from);
      await clearUserWaitingState(from);
    }
    
    await sendMessage(phone_no_id, from, successMessage);
    console.log('✅ [Order Success] Сообщение отправлено');
  } catch (error) {
    console.error('❌ [Order Success] Ошибка отправки сообщения:', error.message);
    console.log('🧹 [Order Success] Очистка состояний после ошибки');
    await deleteUserState(from);
    await clearUserWaitingState(from);
    
    // Отправляем сообщение об ошибке пользователю
    const lan = await getUserLan(from);
    const errorMsg = lan === 'kg'
      ? '❌ Буйрутма кабыл алынды, бирок билдирүү жөнөтүүдө ката кетти. Менеджер сиз менен байланышат.'
      : '❌ Заказ принят, но произошла ошибка при отправке уведомления. Менеджер свяжется с вами.';
    await sendMessage(phone_no_id, from, errorMsg);
  }
}

// ---------------------------- Body parsers ----------------------------
app.use(body_parser.json({ type: ['application/json', 'text/plain'] }));
app.use(body_parser.text({ type: 'text/plain' }));

// ---------------------------- Flow encryption endpoint ----------------------------
app.post("/flow", async (req, res) => {
  console.log('🔐 [Flow Crypto] POST запрос на /flow');
  try {
    const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptRequest(req.body);
    console.log('✅ [Flow Crypto] Запрос расшифрован');
    console.log('📋 [Flow Crypto] Action:', decryptedBody.action);
    
    const responseData = await processFlowData(decryptedBody);
    console.log('✅ [Flow Crypto] Данные обработаны');
    
    const encryptedResponse = encryptResponse(responseData, aesKeyBuffer, initialVectorBuffer);
    console.log('✅ [Flow Crypto] Ответ зашифрован');
    
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(encryptedResponse);
  } catch (error) {
    console.error('❌ [Flow Crypto] Ошибка обработки:', error.message);
    return res.status(421).json({ error: "Request processing failed" });
  }
});

const decryptRequest = (body) => {
  console.log('🔓 [Decrypt] Расшифровка запроса Flow');
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;
  const privatePem = getPrivateKey();
  if (!privatePem) {
    console.error('❌ [Decrypt] Private key не найден');
    throw new Error("Private key not found");
  }

  const decryptedAesKey = crypto.privateDecrypt(
    {
      key: crypto.createPrivateKey(privatePem),
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(encrypted_aes_key, "base64")
  );

  const flowDataBuffer = Buffer.from(encrypted_flow_data, "base64");
  const initialVectorBuffer = Buffer.from(initial_vector, "base64");

  const TAG_LENGTH = 16;
  const encrypted_flow_data_body = flowDataBuffer.subarray(0, -TAG_LENGTH);
  const encrypted_flow_data_tag = flowDataBuffer.subarray(-TAG_LENGTH);

  const decipher = crypto.createDecipheriv("aes-128-gcm", decryptedAesKey, initialVectorBuffer);
  decipher.setAuthTag(encrypted_flow_data_tag);

  const decryptedJSONString = Buffer.concat([decipher.update(encrypted_flow_data_body), decipher.final()]).toString("utf-8");

  console.log('✅ [Decrypt] Данные расшифрованы');
  return { decryptedBody: JSON.parse(decryptedJSONString), aesKeyBuffer: decryptedAesKey, initialVectorBuffer };
};

const encryptResponse = (response, aesKeyBuffer, initialVectorBuffer) => {
  console.log('🔐 [Encrypt] Шифрование ответа Flow');
  const flipped_iv = [];
  for (const pair of initialVectorBuffer.entries()) flipped_iv.push(~pair[1]);
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKeyBuffer, Buffer.from(flipped_iv));
  const encryptedData = Buffer.concat([cipher.update(JSON.stringify(response), "utf-8"), cipher.final(), cipher.getAuthTag()]);
  console.log('✅ [Encrypt] Ответ зашифрован');
  return encryptedData.toString("base64");
};

async function processFlowData(data) {
  console.log('⚙️ [Flow Process] Обработка данных Flow');
  try {
    const { action, flow_token, data: flowData, screen } = data;
    console.log('📋 [Flow Process] Action:', action);
    console.log('📋 [Flow Process] Screen:', screen);
    
    switch (action) {
      case "ping":
        console.log('🏓 [Flow Process] PING');
        return { data: { status: "active" } };
      case "INIT":
        console.log('🚀 [Flow Process] INIT');
        if (flow_token && flow_token.includes("new_customer")) {
          console.log('🆕 [Flow Process] Инициализация для нового клиента');
          return { screen: "WELCOME_NEW", data: { flow_type: "new_customer", branches: flowData?.branches || [] } };
        } else if (flow_token && flow_token.includes("existing_customer")) {
          console.log('👤 [Flow Process] Инициализация для существующего клиента');
          const customerName = flowData?.customer_name || "";
          const userAddresses = flowData?.user_addresses || [];
          const branches = flowData?.branches || [];
          return { screen: "ORDER_TYPE", data: { flow_type: "existing_customer", customer_name: customerName, user_addresses: userAddresses, branches } };
        }
        console.log('⚠️ [Flow Process] Неизвестный тип инициализации');
        return { screen: "ORDER_TYPE", data: {} };
      case "data_exchange":
        console.log('🔄 [Flow Process] DATA_EXCHANGE');
        return await handleDataExchange(screen, flowData, flow_token);
      default:
        console.log('⚠️ [Flow Process] Неизвестный action:', action);
        return { data: { status: "active" } };
    }
  } catch (error) {
    console.error('❌ [Flow Process] Ошибка:', error.message);
    return { data: { status: "active" } };
  }
}

async function handleDataExchange(screen, data, flow_token) {
  console.log('🔄 [Data Exchange] Экран:', screen);
  try {
    switch (screen) {
      case "WELCOME_NEW":
        console.log('🆕 [Data Exchange] WELCOME_NEW -> ORDER_TYPE_NEW');
        return { screen: "ORDER_TYPE_NEW", data: { flow_type: "new_customer", customer_name: data.customer_name, branches: data.branches } };
      case "ORDER_TYPE_NEW":
        console.log('📋 [Data Exchange] ORDER_TYPE_NEW -> DELIVERY_OPTIONS_NEW');
        return { screen: "DELIVERY_OPTIONS_NEW", data: { flow_type: "new_customer", customer_name: data.customer_name, order_type: data.order_type, branches: data.branches } };
      case "DELIVERY_OPTIONS_NEW":
        console.log('✅ [Data Exchange] DELIVERY_OPTIONS_NEW -> SUCCESS');
        return {
          screen: "SUCCESS",
          data: {
            extension_message_response: {
              params: {
                flow_token, flow_type: "new_customer",
                customer_name: data.customer_name, order_type: data.order_type, branch: data.branch, delivery_address: data.delivery_address
              }
            }
          }
        };
      case "ORDER_TYPE":
        console.log('📋 [Data Exchange] ORDER_TYPE -> DELIVERY_OPTIONS');
        return { screen: "DELIVERY_OPTIONS", data: { flow_type: "existing_customer", customer_name: data.customer_name, order_type: data.order_type, user_addresses: data.user_addresses, branches: data.branches } };
      case "DELIVERY_OPTIONS":
        console.log('✅ [Data Exchange] DELIVERY_OPTIONS -> SUCCESS');
        return {
          screen: "SUCCESS",
          data: {
            extension_message_response: {
              params: {
                flow_token, flow_type: "existing_customer",
                customer_name: data.customer_name, order_type: data.order_type, delivery_choice: data.delivery_choice, new_address: data.new_address, branch: data.branch
              }
            }
          }
        };
      default:
        console.log('⚠️ [Data Exchange] Неизвестный экран:', screen);
        return { screen: "ORDER_TYPE", data: {} };
    }
  } catch (error) {
    console.error('❌ [Data Exchange] Ошибка:', error.message);
    return { screen, data: { error_message: "Произошла ошибка. Попробуйте еще раз." } };
  }
}

function getPrivateKey() {
  console.log('🔑 [Private Key] Получение приватного ключа');
  try {
    if (process.env.PRIVATE_KEY) {
      console.log('✅ [Private Key] Из переменной окружения');
      return process.env.PRIVATE_KEY.replace(/\\n/g, '\n');
    }
    if (fs.existsSync('./private_key.pem')) {
      console.log('✅ [Private Key] Из файла ./private_key.pem');
      return fs.readFileSync('./private_key.pem', 'utf8');
    }
    console.log('❌ [Private Key] Не найден');
    return null;
  } catch (error) {
    console.error('❌ [Private Key] Ошибка:', error.message);
    return null;
  }
}

// ---------------------------- Order status notify API ----------------------------
app.post("/order-status", async (req, res) => {
  console.log('📊 [Order Status API] POST запрос получен');
  try {
    if (typeof req.body === 'string') {
      console.log('🔄 [Order Status API] Парсинг строкового body');
      try { req.body = JSON.parse(req.body); } catch {}
    }

    const { phone, order_id, status, order_type, location_title, estimated_time, additional_info } = req.body;
    console.log('📋 [Order Status API] Телефон:', phone);
    console.log('📋 [Order Status API] Order ID:', order_id);
    console.log('📋 [Order Status API] Статус:', status);
    
    if (!phone || !order_id || !status) {
      console.log('❌ [Order Status API] Недостаточно данных');
      return res.status(400).json({ success: false, error: "Обязательные поля: phone, order_id, status" });
    }

    const phone_no_id = process.env.PHONE_NUMBER_ID;
    if (!phone_no_id) {
      console.log('❌ [Order Status API] PHONE_NUMBER_ID не настроен');
      return res.status(500).json({ success: false, error: "PHONE_NUMBER_ID не настроен" });
    }

    const result = await sendOrderStatusNotification(
      phone_no_id, phone, order_id, status, order_type, location_title, estimated_time, additional_info
    );

    if (result.success) {
      console.log('✅ [Order Status API] Уведомление отправлено');
      res.status(200).json({ success: true, message: "Уведомление отправлено", whatsapp_message_id: result.message_id });
    } else {
      console.log('❌ [Order Status API] Ошибка отправки:', result.error);
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('❌ [Order Status API] Критическая ошибка:', error.message);
    res.status(500).json({ success: false, error: "Внутренняя ошибка сервера" });
  }
});

async function sendOrderStatusNotification(phone_no_id, customerPhone, orderId, status, orderType = 'pickup', locationTitle = '', estimatedTime = '', additionalInfo = '') {
  console.log('📨 [Status Notification] Отправка уведомления о статусе');
  console.log('📋 [Status Notification] Клиент:', customerPhone);
  console.log('📋 [Status Notification] Статус:', status);
  
  try {
    const message = await formatOrderStatusMessage(orderId, status, orderType, locationTitle, estimatedTime, additionalInfo, customerPhone.replace("+", ""));
    const response = await sendMessage(phone_no_id, customerPhone.replace("+", ""), message);
    console.log('✅ [Status Notification] Уведомление отправлено');
    return { success: true, message_id: response.messages?.[0]?.id };
  } catch (error) {
    console.error('❌ [Status Notification] Ошибка:', error.message);
    return { success: false, error: error.message };
  }
}

async function formatOrderStatusMessage(orderId, status, orderType, locationTitle, estimatedTime, additionalInfo, from) {
  console.log('📝 [Format Status] Форматирование сообщения о статусе');
  const lan = await getUserLan(from);
  const userState = await getUserState(from);
  const ordType = userState?.order_type;

  let m = '';

  switch (status) {
    case 'NEW':
      console.log('📝 [Format Status] NEW');
      m += lan === 'ru' ? '📝 Заказ создан. Ожидает подтверждения.\n\n'
                        : '📝 Буйрутма түзүлдү. Ырастоону күтүп жатат.\n\n';
      break;
    case 'ACCEPTED':
      console.log('✅ [Format Status] ACCEPTED');
      m += lan === 'ru' ? '✅ Заказ принят в работу.\n\n'
                        : '✅ Буйрутма иштетүүгө кабыл алынды.\n\n';
      break;
    case 'PRODUCTION':
      console.log('👨‍🍳 [Format Status] PRODUCTION');
      m += lan === 'ru' ? '👨‍🍳 Заказ готовится.\n\n'
                        : '👨‍🍳 Буйрутма даярдалууда.\n\n';
      break;
    case 'COMPLETED':
      console.log('🎉 [Format Status] COMPLETED');
      if (ordType === 'delivery') {
        m += lan === 'ru' ? '🎉 Заказ готов. Ожидайте доставку.\n\n'
                          : '🎉 Буйрутма даяр. Жеткирүү күтүлүүдө.\n\n';
      } else {
        m += lan === 'ru' ? '🎉 Заказ готов к выдаче.\n\n'
                          : '🎉 Буйрутма алып кетүүгө даяр.\n\n';
      }
      break;
    case 'OUT_FOR_DELIVERY':
      console.log('🚗 [Format Status] OUT_FOR_DELIVERY');
      m += lan === 'ru' ? '🚗 Курьер в пути.\n\n'
                        : '🚗 Курьер жолдо.\n\n';
      break;
    case 'DELIVERED':
    case 'DONE':
      console.log('✅ [Format Status] DELIVERED/DONE');
      m += lan === 'ru' ? '✅ Заказ успешно выполнено. Спасибо.\n'
                        : '✅ Буйрутма ийгиликтүү аткарылды. Рахмат.\n';
      console.log('🧹 [Format Status] Очистка состояний (заказ завершен)');
      await deleteUserState(from);
      await clearUserWaitingState(from);
      break;
    case 'CANCELLED':
      console.log('❌ [Format Status] CANCELLED');
      m += lan === 'ru' ? '❌ Заказ отменен.\n'
                        : '❌ Буйрутма жокко чыгарылды.\n';
      console.log('🧹 [Format Status] Очистка состояний (заказ отменен)');
      await deleteUserState(from);
      await clearUserWaitingState(from);
      break;
    case 'DELAYED':
      console.log('⏰ [Format Status] DELAYED');
      m += lan === 'ru' ? '⏰ Небольшая задержка.\n'
                        : '⏰ Кичине кечигүү.\n';
      if (estimatedTime) m += `🕐 ${estimatedTime}\n`;
      if (additionalInfo) m += `📝 ${additionalInfo}\n`;
      break;
    default:
      console.log('❓ [Format Status] UNKNOWN:', status);
      m += lan === 'ru' ? `📋 Статус: ${status}\n`
                        : `📋 Статус: ${status}\n`;
  }
  return m;
}

// ---------------------------- POST endpoint from menu site ----------------------------
app.post("/menu-order", async (req, res) => {
  console.log('🛒 [Menu Order] POST запрос от сайта меню');
  try {
    if (typeof req.body === 'string') {
      console.log('🔄 [Menu Order] Парсинг строкового body');
      try { req.body = JSON.parse(req.body); } catch {}
    }
    
    const isArray = Array.isArray(req.body);
    const items = isArray ? req.body
                          : (Array.isArray(req.body?.items) ? req.body.items : null);

    const phoneRaw = isArray ? (req.query.phone || req.body?.phone)
                             : (req.body?.phone || req.query.phone);
    const phone = normalizePhone(phoneRaw);

    console.log('📋 [Menu Order] Телефон:', phone);
    console.log('📋 [Menu Order] Товаров:', items?.length || 0);

    if (!phone || !items) {
      console.log('❌ [Menu Order] Недостаточно данных');
      return res.status(400).json({ success: false, error: "Required: phone and items[]" });
    }

    const phone_no_id = process.env.PHONE_NUMBER_ID;
    if (!phone_no_id) {
      console.log('❌ [Menu Order] PHONE_NUMBER_ID не настроен');
      return res.status(500).json({ success: false, error: "PHONE_NUMBER_ID not set" });
    }

    const currentWaitingState = await getUserWaitingState(phone);
    console.log('🔍 [Menu Order] Текущее состояние:', currentWaitingState);

    if (currentWaitingState !== WAITING_STATES.CATALOG_ORDER) {
      console.log('⚠️ [Menu Order] Неверное состояние, заказ отклонен');
      const lan = await getUserLan(phone);
      const message = lan === 'kg' 
        ? '⚠️ Буйрутма берүү мүмкүн эмес. Сураныч, баштан баштаңыз.' 
        : '⚠️ Невозможно оформить заказ. Пожалуйста, начните процесс заново.';
      
      return res.status(403).json({ 
        success: false, 
        error: "Order not allowed in current state",
        message: message
      });
    }

    const lan = await getUserLan(phone);

    let orderSummary = lan === 'kg' ? "🛒 Сиздин буйрутмаңыз:\n\n" : "🛒 Ваш заказ:\n\n";
    let totalAmount = 0;
    const orderItems = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const productInfo = await getProductInfo(it.product_retailer_id);
      const name = productInfo.title || `Товар ${it.product_retailer_id}`;
      const price = Number(it.item_price) || 0;
      const qty = Number(it.quantity) || 0;
      const line = price * qty;

      console.log(`📦 [Menu Order] ${i + 1}. ${name} x${qty} = ${line} KGS`);

      orderSummary += `${i + 1}. ${name}\n`;
      orderSummary += lan === 'kg'
        ? `Даанасы: ${qty} ${productInfo.measure_unit || 'шт'}\nБаасы: ${price} KGS x ${qty} = ${line} KGS\n\n`
        : `Количество: ${qty} ${productInfo.measure_unit || 'шт'}\nЦена: ${price} KGS x ${qty} = ${line} KGS\n\n`;

      totalAmount += line;
      orderItems.push({
        id: parseInt(productInfo.api_id),
        title: name,
        quantity: qty,
        priceWithDiscount: null,
        dealDiscountId: null,
        modifierGroups: []
      });
    }

    orderSummary += lan === 'kg'
      ? `💰 Жалпы наркы: ${totalAmount} KGS\n\n`
      : `💰 Общая стоимость: ${totalAmount} KGS\n\n`;

    console.log('💰 [Menu Order] Итоговая сумма:', totalAmount, 'KGS');

    const userState = await getUserState(phone);

    await calculateDeliveryAndSubmitOrder(
      phone_no_id, phone, orderItems, totalAmount, orderSummary, userState
    );

    console.log('✅ [Menu Order] Заказ обработан успешно');
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error("❌ [Menu Order] Критическая ошибка:", e.message);
    console.error("❌ [Menu Order] Stack:", e.stack);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
});

// ---------------------------- Stats / Cleanup / Root ----------------------------
app.get("/stats", async (_req, res) => {
  console.log('📊 [Stats] GET запрос статистики');
  try {
    const totalUsers = await userStatesCollection.countDocuments();
    const waitingStates = await userStatesCollection.aggregate([{ $group: { _id: "$waitingState", count: { $sum: 1 } } }]).toArray();
    const agg = waitingStates.reduce((acc, i) => { acc[i._id || 'none'] = i.count; return acc; }, {});
    console.log('✅ [Stats] Всего пользователей:', totalUsers);
    res.status(200).json({ success: true, timestamp: new Date().toISOString(), database: { connected: !!db, name: DB_NAME }, statistics: { totalUsers, waitingStates: agg } });
  } catch (error) {
    console.error('❌ [Stats] Ошибка:', error.message);
    res.status(500).json({ success: false, error: "Ошибка получения статистики" });
  }
});

app.delete("/cleanup", async (_req, res) => {
  console.log('🧹 [Cleanup] DELETE запрос очистки');
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await userStatesCollection.deleteMany({ updatedAt: { $lt: oneDayAgo } });
    console.log('✅ [Cleanup] Удалено записей:', result.deletedCount);
    res.status(200).json({ success: true, message: `Удалено ${result.deletedCount} старых состояний`, deletedCount: result.deletedCount });
  } catch (error) {
    console.error('❌ [Cleanup] Ошибка:', error.message);
    res.status(500).json({ success: false, error: "Ошибка очистки состояний" });
  }
});

app.get("/", (_req, res) => {
  console.log('🏠 [Root] GET запрос на главную');
  res.status(200).json({
    message: "WhatsApp Bot с MongoDB",
    status: "active",
    version: "2.3.0",
    database: { connected: !!db, name: DB_NAME },
    features: [
      "MongoDB состояния",
      "Flow обработка",
      "Сайт меню вместо каталога WhatsApp",
      "Открытый POST /menu-order",
      "Уведомления о заказах",
      "AI-помощь в середине оформления заказа",
      "Возобновление процесса (resume checkpoint)",
      "Полное логирование для отладки"
    ],
    endpoints: { 
      webhook: "/webhook", 
      flow: "/flow", 
      menuOrder: "/menu-order", 
      orderStatus: "/order-status", 
      stats: "/stats", 
      cleanup: "/cleanup" 
    }
  });
});

// ---------------------------- Process signals ----------------------------
process.on('SIGINT', async () => {
  console.log('⚠️ [Process] Получен сигнал SIGINT');
  if (db) {
    console.log('🔌 [Process] Закрытие подключения к MongoDB...');
    await db.client.close();
    console.log('✅ [Process] MongoDB отключен');
  }
  console.log('👋 [Process] Завершение работы');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => { 
  console.error('❌❌❌ [Process] UNHANDLED REJECTION ❌❌❌');
  console.error('Причина:', reason); 
  if (reason?.stack) console.error('Stack:', reason.stack);
});

process.on('uncaughtException', (error) => { 
  console.error('❌❌❌ [Process] UNCAUGHT EXCEPTION ❌❌❌');
  console.error('Ошибка:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1); 
});