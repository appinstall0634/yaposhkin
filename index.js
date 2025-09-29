// index.js — обновленная версия с AI-помощью в середине оформления заказа
// Внимание: файл цельный. Вставьте как есть и проверьте переменные окружения.

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
const { Console } = require('console');

// ---------------------------- Config ----------------------------
const PORT = process.env.PORT || 3500;
const app = express().use(body_parser.json());

const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN;

const TEMIR_API_BASE = 'https://ya.temir.me';

// Flow IDs
const NEW_CUSTOMER_FLOW_ID = '822959930422520';     // RU newCustomer
const ORDER_FLOW_ID = '1265635731924331';           // RU order
const NEW_CUSTOMER_FLOW_ID_KY = '762432499878824';  // KG newCustomer
const ORDER_FLOW_ID_KY = '769449935850843';         // KG order

// MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'whatsapp_bot';
let db = null;
let userStatesCollection = null;
let userDataForOrderCollection = null;

let heavyMedia = false;

// ---------------------------- States ----------------------------
const WAITING_STATES = {
  NONE: 'none',
  LANG: 'lang',
  FLOW_RESPONSE: 'flow_response',
  LOCATION: 'location',
  CATALOG_ORDER: 'catalog_order',
  ORDER_STATUS: 'order-status',
  HELP_CONFIRM: 'help_confirm' // <— новый: подтверждение после ответа AI
};

const contact_branch = {
  '1': '0709063676',
  '15': '0705063676'
};

// ---------------------------- AI Intent ----------------------------
// async function analyzeCustomerIntent(messageText) {
//   try {
//     const { text } = await generateText({
//       model: openai('gpt-4o'),
//       messages: [
//         {
//           role: 'system',
//           content: `Ты эксперт-аналитик намерений клиентов ресторана "Yaposhkin Rolls".
// Верни строго одну строку в формате:
// <INTENT>|<lang>
// Где <INTENT> один из:
// ORDER_INTENT, ORDER_STATUS, ORDER_TRACKING, PICKUP_ADDRESS, MENU_QUESTION, ORDER_FOR_ANOTHER, PAYMENT_METHOD, OTHER_INTENT
// А <lang> один из: ru, kg.
// `
//         },
//         { role: 'user', content: messageText }
//       ],
//       maxTokens: 20,
//       temperature: 0.0
//     });

//     const parts = text.trim().split('|');
//     if (parts.length >= 2) {
//       const intent = parts[0].trim();
//       const language = parts[1].trim();
//       return { intent, isOrderIntent: intent === 'ORDER_INTENT', language, originalText: messageText };
//     }
//     // fallback
//     return analyzeIntentFallback(messageText);
//   } catch {
//     return analyzeIntentFallback(messageText);
//   }
// }

const ERR = {
  LOCATION_CLOSED: 'LOCATION_CLOSED',
  SOLD_OUT: 'SOLD_OUT',
  DELIVERY_UNAVAILABLE: 'DELIVERY_UNAVAILABLE',
  VALIDATION: 'VALIDATION',
  UNKNOWN: 'UNKNOWN',
  MIN_AMOUNT:'MIN_AMOUNT',
};

function classifyPreorderError(error) {
  const http = error?.response?.status;
  const data = error?.response?.data || {};
  const e = data.error || {};
  const type = String(e.type || '').toUpperCase();
  const desc = String(e.description || data.message || '').toLowerCase();

  let code = ERR.UNKNOWN;
  if (type.includes('LOCATIONISCLOSEDEXCEPTION') || desc.includes('location is closed')) code = ERR.LOCATION_CLOSED;
  else if (type.includes('SOLDOUT') || desc.includes('soldout') || desc.includes('out of stock') || desc.includes('unavailable')) code = ERR.SOLD_OUT;
  else if (type.includes('DELIVERYUNAVAILABLE') || desc.includes('delivery unavailable') || http === 404) code = ERR.DELIVERY_UNAVAILABLE;
  else if (http === 400) code = ERR.VALIDATION;

  const productIds = e.productIds || data.productIds || [];
  return { code, productIds, description: e.description || data.message || '' };
}

function listUnavailable(orderItems, ids) {
  return ids
    .map(pid => orderItems.find(o => Number(o.id) === Number(pid))?.title)
    .filter(Boolean)
    .join('\n');
}


async function analyzeCustomerIntent(messageText) {
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
      return { intent, isOrderIntent: intent === 'ORDER_INTENT', language, originalText: messageText };
    }
    return analyzeIntentFallback(messageText);
  } catch {
    return analyzeIntentFallback(messageText);
  }
}


// Единая fallback-функция
function analyzeIntentFallback(messageText) {
  const text = (messageText || '').toLowerCase();

  const kgWords = ['буйрутма', 'заказ кылгым', 'салам', 'кандайсыз', 'качан', 'канча'];
  const language = kgWords.some(w => text.includes(w)) ? 'kg' : 'ru';

  const statusKeywords = ['когда будет готов', 'готов ли заказ', 'статус заказа', 'где мой заказ', 'сколько ждать', 'заказ качан', 'буйрутма даярбы'];
  if (statusKeywords.some(w => text.includes(w))) return { intent: 'ORDER_STATUS', isOrderIntent: false, language, originalText: messageText };

  const trackingKeywords = ['как отслеживать', 'как узнать статус', 'отслеживание заказа', 'уведомления', 'кантип көзөмөлдөө'];
  if (trackingKeywords.some(w => text.includes(w))) return { intent: 'ORDER_TRACKING', isOrderIntent: false, language, originalText: messageText };

  const addressKeywords = ['адрес самовывоза', 'где находитесь', 'адреса филиалов', 'куда приехать', 'алып кетүү дареги'];
  if (addressKeywords.some(w => text.includes(w))) return { intent: 'PICKUP_ADDRESS', isOrderIntent: false, language, originalText: messageText };

  const menuKeywords = ['есть ли сеты', 'есть ли пицца', 'есть ли бургеры', 'картошка фри', 'полное меню', 'сеттер барбы', 'меню'];
  if (menuKeywords.some(w => text.includes(w))) return { intent: 'MENU_QUESTION', isOrderIntent: false, language, originalText: messageText };

  const anotherPersonKeywords = ['заказ на другого', 'не на себя', 'для кого-то', 'башка адамга'];
  if (anotherPersonKeywords.some(w => text.includes(w))) return { intent: 'ORDER_FOR_ANOTHER', isOrderIntent: false, language, originalText: messageText };

  const paymentKeywords = ['оплата картой', 'можно ли картой', 'принимаете карты', 'онлайн оплата', 'карта менен', 'төлөө'];
  if (paymentKeywords.some(w => text.includes(w))) return { intent: 'PAYMENT_METHOD', isOrderIntent: false, language, originalText: messageText };

  const orderKeywords = ['заказ', 'заказать', 'хочу', 'буду', 'доставка', 'роллы', 'суши', 'каталог', 'буйрутма'];
  if (orderKeywords.some(w => text.includes(w))) return { intent: 'ORDER_INTENT', isOrderIntent: true, language, originalText: messageText };

  return { intent: 'OTHER_INTENT', isOrderIntent: false, language, originalText: messageText };
}

// ---------------------------- MongoDB Init ----------------------------
async function initMongoDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  userStatesCollection = db.collection('user_states');
  userDataForOrderCollection = db.collection('user_orders');

  await userStatesCollection.createIndex({ phone: 1 });
  await userDataForOrderCollection.createIndex({ phone: 1 });
  await userStatesCollection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 86400 });
  await userDataForOrderCollection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 86400 });
}

// ---------------------------- DB Helpers ----------------------------
async function getUserState(phone) {
  const doc = await userStatesCollection.findOne({ phone });
  return doc?.state || null;
}
async function setUserState(phone, state) {
  const now = new Date();
  await userStatesCollection.updateOne(
    { phone },
    { $set: { phone, state, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
}
async function deleteUserState(phone) {
  await userStatesCollection.deleteOne({ phone });
}

async function getUserLan(phone) {
  const doc = await userStatesCollection.findOne({ phone });
  return doc?.lan || 'ru';
}
async function getUserOrders(phone) {
  const doc = await userDataForOrderCollection.findOne({ phone });
  return doc?.state || null;
}
async function setUserOrder(phone, state) {
  const now = new Date();
  await userDataForOrderCollection.updateOne(
    { phone },
    { $set: { phone, state, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
}
async function deleteUserOrders(phone) {
  await userDataForOrderCollection.deleteOne({ phone });
}

async function getUserWaitingState(phone) {
  const doc = await userStatesCollection.findOne({ phone });
  return doc?.waitingState || WAITING_STATES.NONE;
}
async function setUserWaitingState(phone, waitingState, lan) {
  const now = new Date();
  const $set = { phone, waitingState, updatedAt: now };
  if (waitingState === WAITING_STATES.FLOW_RESPONSE && lan) $set.lan = lan;
  await userStatesCollection.updateOne(
    { phone },
    { $set, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
}
async function clearUserWaitingState(phone) {
  await userStatesCollection.updateOne(
    { phone },
    { $unset: { waitingState: "" }, $set: { updatedAt: new Date() } }
  );
}

// ---------- Resume checkpoint (для продолжения после вопросов к AI) ----------
async function setResumeCheckpoint(phone, resume) {
  const now = new Date();
  await userStatesCollection.updateOne(
    { phone },
    { $set: { resume, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
}
async function getResumeCheckpoint(phone) {
  const doc = await userStatesCollection.findOne({ phone });
  return doc?.resume || null;
}
async function clearResumeCheckpoint(phone) {
  await userStatesCollection.updateOne(
    { phone },
    { $unset: { resume: "" }, $set: { updatedAt: new Date() } }
  );
}

// ---------------------------- Server start ----------------------------
async function startServer() {
  await initMongoDB();
  await getAllProductsForSections();
  app.listen(PORT, () => {
    console.log(`Server on http://localhost:${PORT}`);
  });
}
startServer();

// ---------------------------- Verify webhook ----------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const challenge = req.query["hub.challenge"];
  const tokenQ = req.query["hub.verify_token"];
  if (mode && tokenQ) {
    if (mode === "subscribe" && tokenQ === mytoken) res.status(200).send(challenge);
    else res.status(403).send("Forbidden");
  }
});

// ---------------------------- Webhook main ----------------------------
app.post("/webhook", async (req, res) => {
  const body_param = req.body;

  if (body_param.object &&
      body_param.entry &&
      body_param.entry[0].changes &&
      body_param.entry[0].changes[0].value.messages &&
      body_param.entry[0].changes[0].value.messages[0]) {

    const phone_no_id = body_param.entry[0].changes[0].value.metadata.phone_number_id;
    const from = body_param.entry[0].changes[0].value.messages[0].from;
    const message = body_param.entry[0].changes[0].value.messages[0];
    const currentWaitingState = await getUserWaitingState(from);

    try {
      // 1) Локация
      if (message.type === "location" && currentWaitingState === WAITING_STATES.LOCATION) {
        await handleLocationMessage(phone_no_id, from, message);
      }
      // 2) Ответ от Flow
      else if (message.type === "interactive" &&
               message.interactive?.type === "nfm_reply" &&
               currentWaitingState === WAITING_STATES.FLOW_RESPONSE) {
        await handleFlowResponse(phone_no_id, from, message, body_param);
      }
      // 3) Заказ из каталога
      else if (message.type === "order" &&
               currentWaitingState === WAITING_STATES.CATALOG_ORDER) {
        await handleCatalogOrderResponse(phone_no_id, from, message);
      }
      // 4) Кнопки выбора языка
      else if (message.type === "interactive" &&
               message.interactive?.type === "button_reply" &&
               currentWaitingState === WAITING_STATES.LANG) {
        await handleOrderConfirmationButton(phone_no_id, from, message);
      }
      // 5) Кнопки «Продолжить/Отменить» после ответа AI
      else if (message.type === "interactive" &&
               message.interactive?.type === "button_reply" &&
               currentWaitingState === WAITING_STATES.HELP_CONFIRM) {
        const id = message.interactive.button_reply.id;
        if (id === 'continue_order') {
          await resumeFlow(phone_no_id, from);
        } else if (id === 'cancel_order') {
          const lan = await getUserLan(from);
          await deleteUserState(from);
          await clearResumeCheckpoint(from);
          await setUserWaitingState(from, WAITING_STATES.NONE);
          await sendMessage(phone_no_id, from, lan === 'kg' ? '✅ Буйрутмаңыз жокко чыгарылды.' : '✅ Ваш заказ отменен.');
        }
      }
      // 6) Вопрос в середине процесса: текст во время FLOW_RESPONSE или CATALOG_ORDER
      else if (message.type === "text" &&
              (currentWaitingState === WAITING_STATES.FLOW_RESPONSE || currentWaitingState === WAITING_STATES.CATALOG_ORDER || currentWaitingState === WAITING_STATES.HELP_CONFIRM)) {
        await handleMidOrderHelp(phone_no_id, from, message, currentWaitingState, body_param);
      }
      // 7) Обычное текстовое сообщение, когда процессов нет
      else if (message.type === "text" && currentWaitingState === WAITING_STATES.NONE) {
        await handleIncomingMessage(phone_no_id, from, message);
      }
    } catch (e) {
      console.error("Webhook handling error:", e);
    }

    return res.sendStatus(200);
  }

  res.sendStatus(404);
});

// ---------------------------- HELP: mid-order Q&A ----------------------------
async function handleMidOrderHelp(phone_no_id, from, message, currentWaitingState, body_param) {
  const text = message.text?.body || '';
  const analysis = await analyzeCustomerIntent(text);

  // Шаблонные ответы
  if (analysis.intent === 'ORDER_STATUS') {
    await sendOrderStatusResponse(phone_no_id, from, analysis.language);
  } else if (analysis.intent === 'ORDER_TRACKING') {
    await sendOrderTrackingResponse(phone_no_id, from, analysis.language);
  } else if (analysis.intent === 'PICKUP_ADDRESS') {
    await sendPickupAddressResponse(phone_no_id, from, analysis.language);
  } else if (analysis.intent === 'MENU_QUESTION') {
    await sendMenuResponse(phone_no_id, from, analysis.language);
    heavyMedia = true;
  } else if (analysis.intent === 'ORDER_FOR_ANOTHER') {
    await sendOrderForAnotherResponse(phone_no_id, from, analysis.language);
  } else if (analysis.intent === 'PAYMENT_METHOD') {
    await sendPaymentMethodResponse(phone_no_id, from, analysis.language);
  } else if (analysis.intent === 'OTHER_INTENT') {
    await sendManagerContactMessage(phone_no_id, from, analysis.language);
  } else {
    // Если это снова ORDER_INTENT — просто предложим продолжить
    const lan = await getUserLan(from);
    await sendMessage(phone_no_id, from, lan === 'kg'
      ? 'Төмөнкү баскычтардын бирин тандаңыз.'
      : 'Выберите один из вариантов ниже.');
  }

  // Сохранить чекпоинт продолжения
  // Если уже есть, не трогаем. Если нет — поставим по текущему состоянию.
  const resume = await getResumeCheckpoint(from);
  if (!resume) {
    if (currentWaitingState === WAITING_STATES.FLOW_RESPONSE) {
      // Попробуем восстановить контекст для повторной отправки Flow
      // Из входящих данных можем достать контакты/ветки, но проще хранить заранее.
      // Здесь просто ставим «flow», а send*Flow подтянет данные заново.
      await setResumeCheckpoint(from, { kind: 'flow' });
    } else if (currentWaitingState === WAITING_STATES.CATALOG_ORDER) {
      await setResumeCheckpoint(from, { kind: 'catalog' });
    }
  }

  // Переводим в состояние подтверждения
  await setUserWaitingState(from, WAITING_STATES.HELP_CONFIRM);

  if (heavyMedia) await sleep(1500);

  // Кнопки «Продолжить/Отменить»
  await sendHelpContinueButtons(phone_no_id, from);
}

async function sendHelpContinueButtons(phone_no_id, to) {
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
}

// Продолжить процесс по чекпоинту
async function resumeFlow(phone_no_id, from) {
  const lan = await getUserLan(from);
  const resume = await getResumeCheckpoint(from);

  if (!resume) {
    await setUserWaitingState(from, WAITING_STATES.NONE);
    await sendMessage(phone_no_id, from, lan === 'kg'
      ? 'Кечиресиз, улантуучу кадам табылган жок.'
      : 'Извините, нечего возобновлять.');
    return;
  }

  if (resume.kind === 'flow') {
    // Проверим клиента и отправим нужный Flow заново
    await checkCustomerAndSendFlow(phone_no_id, from, lan);
    await setUserWaitingState(from, WAITING_STATES.FLOW_RESPONSE, lan);
    // чекпоинт оставим, чтобы можно было снова вернуться при следующем вопросе
  } else if (resume.kind === 'catalog') {
    await sendCatalog(phone_no_id, from);
    await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
  } else {
    await setUserWaitingState(from, WAITING_STATES.NONE);
  }
}

// ---------------------------- WhatsApp helpers ----------------------------
async function sendWhatsAppMessage(phone_no_id, messageData) {
  const response = await axios({
    method: "POST",
    url: `https://graph.facebook.com/v23.0/${phone_no_id}/messages?access_token=${token}`,
    data: messageData,
    headers: { "Content-Type": "application/json" }
  });
  return response.data;
}

async function sendMessage(phone_no_id, to, text) {
  const data = { messaging_product: "whatsapp", to, text: { body: text || "Сообщение" } };
  return await sendWhatsAppMessage(phone_no_id, data);
}

// ---------------------------- Language choose ----------------------------
async function handleOrderConfirmationButton(phone_no_id, from, message) {
  try {
    const buttonId = message.interactive.button_reply.id; // 'kg' | 'ru'
    await handleIncomingMessage(phone_no_id, from, message, buttonId);
  } catch (error) {
    await sendMessage(phone_no_id, from, "Ошибка. Попробуйте еще раз.");
  }
}

async function sendOrderConfirmationButtons(phone_no_id, to) {
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
}

// ---------------------------- High-level flow entry ----------------------------
async function handleIncomingMessage(phone_no_id, from, message, buttonLang = null) {
  const messageText = message.text?.body || '';

  if (buttonLang) {
    await checkCustomerAndSendFlow(phone_no_id, from, buttonLang);
    return;
  }

  try {
    const intent = await analyzeCustomerIntent(messageText);
    switch (intent.intent) {
      case 'ORDER_INTENT':
        await sendOrderConfirmationButtons(phone_no_id, from);
        break;
      case 'ORDER_STATUS':
        await sendOrderStatusResponse(phone_no_id, from, intent.language);
        break;
      case 'ORDER_TRACKING':
        await sendOrderTrackingResponse(phone_no_id, from, intent.language);
        break;
      case 'PICKUP_ADDRESS':
        await sendPickupAddressResponse(phone_no_id, from, intent.language);
        break;
      case 'MENU_QUESTION':
        await sendMenuResponse(phone_no_id, from, intent.language);
        break;
      case 'ORDER_FOR_ANOTHER':
        await sendOrderForAnotherResponse(phone_no_id, from, intent.language);
        break;
      case 'PAYMENT_METHOD':
        await sendPaymentMethodResponse(phone_no_id, from, intent.language);
        break;
      case 'OTHER_INTENT':
      default:
        await sendManagerContactMessage(phone_no_id, from, intent.language);
        break;
    }
  } catch {
    await sendOrderConfirmationButtons(phone_no_id, from);
  }
}

// ---------------------------- Flow router ----------------------------
async function checkCustomerAndSendFlow(phone_no_id, from, lan) {
  try {
    const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
    const restaurants = restaurantsResponse.data;
    const branches = restaurants.map(r => ({ id: r.external_id.toString(), title: `🏪 ${r.title}` }));

    const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
    const customerData = customerResponse.data;

    const hasAddresses = customerData.customer.addresses && customerData.customer.addresses.length > 0;
    const isNewCustomer = !hasAddresses || !customerData.customer.first_name || customerData.customer.first_name === 'Имя';

    if (isNewCustomer) {
      if (lan === 'kg') await sendNewCustomerFlowKy(phone_no_id, from, branches);
      else await sendNewCustomerFlow(phone_no_id, from, branches);

      await setResumeCheckpoint(from, { kind: 'flow' }); // чекпоинт для возобновления
    } else {
      if (lan === 'kg') await sendExistingCustomerFlowKy(phone_no_id, from, customerData.customer, branches);
      else await sendExistingCustomerFlow(phone_no_id, from, customerData.customer, branches);

      await setResumeCheckpoint(from, { kind: 'flow' }); // чекпоинт для возобновления
    }

    await setUserWaitingState(from, WAITING_STATES.FLOW_RESPONSE, lan);
  } catch (error) {
    try {
      const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
      const restaurants = restaurantsResponse.data;
      const branches = restaurants.map(r => ({ id: r.external_id.toString(), title: `🏪 ${r.title}` }));
      await sendNewCustomerFlow(phone_no_id, from, branches);
      await setUserWaitingState(from, WAITING_STATES.FLOW_RESPONSE, lan);
      await setResumeCheckpoint(from, { kind: 'flow' });
    } catch {
      await sendMessage(phone_no_id, from, "Извините, технические проблемы. Попробуйте позже.");
    }
  }
}

// ---------------------------- Flow messages ----------------------------
async function sendNewCustomerFlow(phone_no_id, from, branches) {
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
}
async function sendNewCustomerFlowKy(phone_no_id, from, branches) {
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
}

async function sendExistingCustomerFlow(phone_no_id, from, customer, branches) {
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
}
async function sendExistingCustomerFlowKy(phone_no_id, from, customer, branches) {
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
}

// ---------------------------- Flow response handler ----------------------------
async function handleFlowResponse(phone_no_id, from, message, body_param) {
  try {
    const flowResponse = JSON.parse(message.interactive.nfm_reply.response_json);

    if (flowResponse.flow_type === 'new_customer') {
      await handleNewCustomerRegistration(phone_no_id, from, flowResponse);
    } else if (flowResponse.flow_type === 'existing_customer') {
      await handleExistingCustomerOrder(phone_no_id, from, flowResponse);
    } else {
      await sendMessage(phone_no_id, from, "Ошибка обработки flow!");
    }
  } catch (error) {
    await sendMessage(phone_no_id, from, "Ошибка обработки формы. Попробуйте еще раз.");
    await clearUserWaitingState(from);
  }
}

// ---------------------------- Registration / Orders from flow ----------------------------
async function handleNewCustomerRegistration(phone_no_id, from, data) {
  try {
    if (data.order_type === 'delivery' && data.delivery_address) {
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
    } else {
      await registerCustomerWithoutLocation(phone_no_id, from, data);
    }
  } catch {
    await sendMessage(phone_no_id, from, 'Ошибка при регистрации. Попробуйте позже.');
    await clearUserWaitingState(from);
  }
}

async function registerCustomerWithoutLocation(phone_no_id, from, data) {
  try {
    const lan = await getUserLan(from);
    const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
    const qr_token = customerResponse.data.qr_access_token;

    const updateData = { firstName: data.customer_name };
    await axios.post(`${TEMIR_API_BASE}/qr/update-customer/?qr_token=${qr_token}`, updateData);

    let confirmText = `Спасибо за регистрацию, ${data.customer_name}! 🎉\n\nВы выбрали самовывоз.\n\nТеперь выберите блюда из нашего каталога! 🍣`;
    if (lan === 'kg') {
      confirmText = `Катталганыңыз үчүн рахмат, ${data.customer_name}! 🎉\n\nСиз алып кетүүнү тандадыңыз.\n\nЭми биздин каталогдон тамактарды тандаңыз! 🍣`;
    }
    await sendMessage(phone_no_id, from, confirmText);

    await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
    await setResumeCheckpoint(from, { kind: 'catalog' });
    await sendCatalog(phone_no_id, from);
  } catch {
    await sendMessage(phone_no_id, from, "Ошибка регистрации. Попробуйте еще раз.");
    await clearUserWaitingState(from);
  }
}

async function handleExistingCustomerOrder(phone_no_id, from, data) {
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
      const updatedUserState = {
        ...userState,
        delivery_address: data.new_address
      };
      await setUserState(from, updatedUserState);
      await setUserWaitingState(from, WAITING_STATES.LOCATION);
      await sendLocationRequest(phone_no_id, from, data.customer_name);
    } else {
      let confirmText;
      if (data.order_type === 'delivery') {
        const title = data.user_addresses.find(a => a.id === data.delivery_choice)?.title || '';
        confirmText = lan === 'kg'
          ? `✅ Эң сонун! Заказ тандалган дарекке жеткирилет.\n\n${title}\n\nКаталогдон тамактарды тандаңыз:`
          : `✅ Отлично! Заказ будет доставлен по выбранному адресу.\n\n${title}\n\nВыберите блюда из каталога:`;
      } else {
        const t = data.branches.find(b => b.id === data.branch)?.title || '';
        confirmText = lan === 'kg'
          ? `✅ Абдан жакшы! Сиз алып кетүүнү тандадыңыз.\n\n${t}\n\nКаталогдон тамактарды тандаңыз:`
          : `✅ Отлично! Вы выбрали самовывоз.\n\n${t}\n\nВыберите блюда из каталога:`;
      }
      await sendMessage(phone_no_id, from, confirmText);
      await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
      await setResumeCheckpoint(from, { kind: 'catalog' });
      await sendCatalog(phone_no_id, from);
    }
  } catch {
    await sendMessage(phone_no_id, from, 'Ошибка. Попробуйте еще раз.');
    await clearUserWaitingState(from);
  }
}

// ---------------------------- Location flow ----------------------------
async function sendLocationRequest(phone_no_id, from, customerName) {
  const lan = await getUserLan(from);
  const text = lan === 'kg'
    ? `Рахмат, ${customerName}! 📍\n\nТак жеткирүү үчүн жайгашкан жериңизди бөлүшүңүз.`
    : `Спасибо, ${customerName}! 📍\n\nДля точной доставки, пожалуйста, поделитесь своим местоположением.`;
  await sendMessage(phone_no_id, from, text);
}

async function handleLocationMessage(phone_no_id, from, message) {
  try {
    const { longitude, latitude } = message.location;
    const userState = await getUserState(from);
    if (!userState) {
      await sendMessage(phone_no_id, from, "Произошла ошибка. Попробуйте заново оформить заказ.");
      await clearUserWaitingState(from);
      return;
    }

    await updateCustomerWithLocation(phone_no_id, from, userState, longitude, latitude);
  } catch {
    await sendMessage(phone_no_id, from, "Ошибка при сохранении адреса. Попробуйте еще раз.");
    await clearUserWaitingState(from);
  }
}

async function updateCustomerWithLocation(phone_no_id, from, userState, longitude, latitude) {
  const lan = await getUserLan(from);
  try {
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

    await axios.post(`${TEMIR_API_BASE}/qr/update-customer/?qr_token=${qr_token}`, updateData);

    const updatedState = {
      ...userState,
      order_type: 'delivery',
      delivery_choice: 'new',
      location_processed: true,
      new_address: userState.delivery_address
    };
    await setUserState(from, updatedState);

    let confirmText = lan === 'kg'
      ? `Катталганыңыз үчүн рахмат, ${userState.customer_name}! 🎉\n\nДарегиңиз сакталды: ${userState.delivery_address}\n\nЭми буйрутмаларды бере аласыз. Мен сизге азыр биздин каталогду жөнөтөм! 🍣`
      : `Спасибо за регистрацию, ${userState.customer_name}! 🎉\n\nВаш адрес сохранен: ${userState.delivery_address}\n\nТеперь вы можете делать заказы. Сейчас отправлю вам наш каталог! 🍣`;
    if (userState.flow_type !== 'new_customer') {
      confirmText = lan === 'kg'
        ? `✅ Жаңы дарек кошулду!\n\n📍 ${userState.delivery_address}\n\nЭми каталогдон тамактарды тандаңыз:`
        : `✅ Новый адрес добавлен!\n\n📍 ${userState.delivery_address}\n\nТеперь выберите блюда из каталога:`;
    }

    await sendMessage(phone_no_id, from, confirmText);

    await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
    await setResumeCheckpoint(from, { kind: 'catalog' });
    await sendCatalog(phone_no_id, from);
  } catch (error) {
    await sendMessage(phone_no_id, from, "Произошла ошибка при сохранении данных.");
    await deleteUserState(from);
    await clearUserWaitingState(from);
  }
}

// ---------------------------- Catalog / Order ----------------------------
let productsCache = null;
let productsCacheForSection = null;

async function getAllProducts() {
  if (productsCache) return productsCache;
  const response = await axios.get(`${TEMIR_API_BASE}/qr/products`);
  const products = response.data;
  const map = {};
  products.forEach(p => { map[p.id] = { id: p.id, api_id: p.api_id, title: p.title, measure_unit: p.measure_unit_title || 'шт' }; });
  productsCache = map;
  return map;
}
async function getAllProductsForSections() {
  if (productsCacheForSection) return productsCacheForSection;
  const response = await axios.get(`${TEMIR_API_BASE}/qr/products`);
  const products = response.data;
  const map = {};
  products.forEach(p => { map[p.api_id] = { id: p.id, api_id: p.api_id, title: p.title }; });
  productsCacheForSection = map;
  return map;
}
async function getProductInfo(productId) {
  const products = await getAllProducts();
  if (products[productId]) return products[productId];
  const response = await axios.get(`${TEMIR_API_BASE}/qr/products/${productId}`);
  const p = response.data;
  return { id: p.id, api_id: p.api_id, title: p.title, measure_unit: p.measure_unit_title || 'шт' };
}

async function resolveLocationId(from) {
  const userState = (await getUserState(from)) || {};
  let locationId = null;

  // pickup: приоритет выбранной ветки, иначе первый ресторан
  if (userState.order_type !== 'delivery') {
    if (userState.branch) {
      const branchInfo = await getBranchInfo(String(userState.branch));
      if (branchInfo) return parseInt(branchInfo.id);
    }
    const restaurants = (await axios.get(`${TEMIR_API_BASE}/qr/restaurants`)).data || [];
    if (restaurants[0]) return restaurants[0].external_id;
    return 1; // запасной вариант
  }

  // delivery: берем координаты адреса
  const { data: customerData } = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
  let address = null;

  if (userState.delivery_choice === 'new' || userState.location_processed) {
    const addresses = customerData.customer.addresses || [];
    address = addresses[addresses.length - 1] || null;
  } else if (userState.delivery_choice?.startsWith('address_')) {
    const id = parseInt(userState.delivery_choice.replace('address_', ''));
    address = (customerData.customer.addresses || []).find(a => a.id == id) || null;
  }

  const geo = address?.geocoding_json || address?.geocoding || null;
  const lat = geo?.latitude, lon = geo?.longitude;
  if (!lat || !lon) return null;

  const delivery = (await axios.get(`${TEMIR_API_BASE}/qr/delivery/?lat=${lat}&lon=${lon}`)).data || [];
  if (delivery[0]?.restaurant_id) locationId = delivery[0].restaurant_id;

  return locationId || null;
}

async function fetchAndConvertMenuData(from) {
  try {
    const locationId = await resolveLocationId(from);
    if (!locationId) return null;

    const { data: apiData } = await axios.get(`${TEMIR_API_BASE}/qr/catalog?location_id=${locationId}`);
    const products = await getAllProductsForSections();

    // apiData = массив групп; каждая группа = массив секций
    const optimizedMenuGroups = apiData.map(group =>
      group.map(section => ({
        section_title: section.section_title,
        products: (section.products || [])
          .map(api_id => products[api_id]?.id)
          .filter(Boolean)
      }))
    );

    return optimizedMenuGroups;
  } catch (e) {
    console.error('fetchAndConvertMenuData error:', e);
    return null;
  }
}

async function sendProductListWithSections(phone_no_id, to, categories, groupNumber, totalGroups, catalogId, lan) {
  const sections = categories.map(category => ({
    title: category.section_title,
    product_items: category.products.map(id => ({ product_retailer_id: id }))
  }));

  let headerText;
  if (categories.length === 1) headerText = `🍣 ${categories[0].section_title}`;
  else if (categories.length === 2) headerText = `🍣 ${categories[0].section_title} и ${categories[1].section_title}`;
  else if (categories.length === 3) headerText = `🍣 ${categories[0].section_title}, ${categories[1].section_title} и ${categories[2].section_title}`;
  else if (categories.length === 4) {

            headerText = `🍣 ${categories[0].section_title}, ${categories[1].section_title}, ${categories[2].section_title} и ${categories[3].section_title}`;
        } else {
            const remaining = categories.length - 2;
            headerText = `🍣 ${categories[0].section_title}, ${categories[1].section_title} +${remaining} категорий`;
        }

  const productListData = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "product_list",
      header: { type: "text", text: '' },
      // body: { text: lan === 'kg' ? "Тамактарды танданыз:" : "Выберите блюда:" },
      body: { text: headerText },
      footer: { text: "" },
      action: { catalog_id: catalogId, sections }
    }
  };
  await sendWhatsAppMessage(phone_no_id, productListData);
}

async function sendCatalog(phone_no_id, to) {
  const lan = await getUserLan(to);
  try {
    const catalogId = process.env.CATALOG_ID;
    const categoryGroups = await fetchAndConvertMenuData(to);
    if (!catalogId || !categoryGroups) throw new Error('catalog missing');

    for (let i = 0; i < categoryGroups.length; i++) {
      const group = categoryGroups[i];
      await sendProductListWithSections(phone_no_id, to, group, i + 1, categoryGroups.length, catalogId, lan);
    }
    await sendMessage(phone_no_id, to, lan === 'kg'
      ? 'Каалаган категориядан тамактарды тандаңыз.'
      : 'Выберите понравившиеся блюда из любой категории.');
  } catch (error) {
    await sendMessage(phone_no_id, to, lan === 'kg' ? "Каталогду жөнөтүүдө ката." : "Ошибка отправки каталога.");
  }
}

async function handleCatalogOrderResponse(phone_no_id, from, message) {
  const lan = await getUserLan(from);
  try {
    const order = message.order;

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

    orderSummary += lan === 'kg' ? `💰 Жалпы наркы: ${totalAmount} KGS\n\n` : `💰 Общая стоимость: ${totalAmount} KGS\n\n`;

    let userState = await getUserState(from);
    await calculateDeliveryAndSubmitOrder(phone_no_id, from, orderItems, totalAmount, orderSummary, userState);
  } catch (error) {
    await sendMessage(phone_no_id, from, "Произошла ошибка при обработке заказа. Попробуйте еще раз.");
    await clearUserWaitingState(from);
  }
}

// utils
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function getLocationWorkingHours(locationId) {
  try {
    const { data: restaurants } = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
    const r = restaurants.find(x => String(x.external_id) === String(locationId));
    if (!r) return null;

    // 1) Явно "на сегодня"
    const t = r.working_hours_today || r.workingHoursToday || null;
    if (t) {
      const open = t.open || t.openTime || t.start || t.from;
      const close = t.close || t.closeTime || t.end || t.to;
      if (open && close) return `${open} - ${close}`;
    }

    // 2) По дням недели
    const daysEn = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const todayKey = daysEn[new Date().getDay()];
    const wh = r.working_hours || r.workingHours || r.schedule || null;
    if (wh && wh[todayKey]) {
      const d = wh[todayKey];
      const open = d.open || d.openTime || d.start || d.from;
      const close = d.close || d.closeTime || d.end || d.to;
      if (open && close) return `${open} - ${close}`;
      if (typeof d === 'string') return d;
    }

    // 3) Одна строка
    if (typeof r.working_hours === 'string') return r.working_hours;
    if (typeof r.workingHours === 'string') return r.workingHours;

    return "11:00 - 23:45";
  } catch {
    return "11:00 - 23:45";
  }
}

// ---------------------------- Delivery calc + submit ----------------------------
async function calculateDeliveryAndSubmitOrder(phone_no_id, from, orderItems, totalAmount, orderSummary, paramUserState) {
  const lan = await getUserLan(from);
  try {
    let userState = paramUserState;
    if (!userState) userState = await getUserState(from);
    if (!userState) userState = { order_type: 'pickup', flow_type: 'fallback' };

    const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
    const customerData = customerResponse.data;

    let deliveryCost = 0;
    let locationId = null;
    let locationTitle = "";
    let orderType = userState.order_type || "pickup";
    let deliveryAddress = "";
    let utensils_count = userState.utensils_count;

    if (orderType === 'delivery') {
      let address = null;
      let tempLat = null;
      let tempLon = null;

      if (userState.delivery_choice === 'new' || userState.location_processed) {
        const addresses = customerData.customer.addresses || [];
        address = addresses[addresses.length - 1];
        deliveryAddress = userState.new_address || userState.delivery_address || address?.full_address || "";
        if (address?.geocoding_json) {
          tempLat = address.geocoding_json.latitude;
          tempLon = address.geocoding_json.longitude;
        }
      } else {
        const addressIndex = parseInt(userState.delivery_choice.replace('address_', ''));
        address = customerData.customer.addresses.find(item => item.id == addressIndex);
        deliveryAddress = address?.full_address || "";
        if (address?.geocoding_json) {
          tempLat = address.geocoding_json.latitude;
          tempLon = address.geocoding_json.longitude;
        }
      }

      if (!tempLat || !tempLon) {
        await sendMessage(phone_no_id, from, "❌ Не удается определить координаты адреса доставки.");
        await deleteUserState(from);
        await clearUserWaitingState(from);
        return;
      }

      try {
        const deliveryResponse = await axios.get(`${TEMIR_API_BASE}/qr/delivery/?lat=${tempLat}&lon=${tempLon}`);
        if (deliveryResponse.data[0]) {
          deliveryCost = deliveryResponse.data[0].delivery_cost || 0;
          locationId = deliveryResponse.data[0].restaurant_id;
          locationTitle = deliveryResponse.data[0].title || "Ресторан";
        } else {
          await sendMessage(phone_no_id, from, "❌ Доставка по этому адресу недоступна.");
          await deleteUserState(from);
          await clearUserWaitingState(from);
          return;
        }
      } catch {
        await sendMessage(phone_no_id, from, "❌ Ошибка при расчете доставки.");
        await deleteUserState(from);
        await clearUserWaitingState(from);
        return;
      }
    } else {
      if (userState?.branch) {
        const branchInfo = await getBranchInfo(userState.branch);
        if (branchInfo) {
          locationId = parseInt(userState.branch);
          locationTitle = branchInfo.title;
        } else {
          await sendMessage(phone_no_id, from, `❌ Ошибка: выбранный филиал недоступен. Обратитесь к менеджеру ${contact_branch['1']}.`);
          await deleteUserState(from);
          await clearUserWaitingState(from);
          return;
        }
      } else {
        const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
        const restaurants = restaurantsResponse.data;
        if (restaurants.length > 0) {
          const selectedBranch = restaurants[0];
          locationId = selectedBranch.external_id;
          locationTitle = selectedBranch.title;
        } else {
          await sendMessage(phone_no_id, from, `❌ Нет доступных филиалов. Обратитесь к менеджеру ${contact_branch['1']}.`);
          await deleteUserState(from);
          await clearUserWaitingState(from);
          return;
        }
      }
    }

    if (!locationId) {
      await sendMessage(phone_no_id, from, "❌ Ошибка определения места выполнения заказа.");
      await deleteUserState(from);
      await clearUserWaitingState(from);
      return;
    }

    const finalAmount = totalAmount + deliveryCost;
    let costMessage = orderSummary;

    if (orderType === "delivery") {
      costMessage += lan === 'kg' ? `🚚 Жеткирүү баасы: ${deliveryCost} KGS\n` : `🚚 Стоимость доставки: ${deliveryCost} KGS\n`;
      costMessage += lan === 'kg' ? `📍 Жеткирүү дареги: ${deliveryAddress}\n\n` : `📍 Адрес доставки: ${deliveryAddress}\n\n`;
    } else {
      costMessage += lan === 'kg' ? `🏪 Алып кетүү: 0 сом\n` : `🏪 Самовывоз: 0 KGS\n`;
      costMessage += `📍 Филиал: ${locationTitle}\n\n`;
    }

    if (userState.payment_method === 'transfer') {
      costMessage += lan === 'kg' ? `💳 Төлөө ыкмасы: Которуу\n` : `💳 Способ оплаты: Перевод\n`;
    } else {
      costMessage += lan === 'kg' ? `💵 Төлөө ыкмасы: Жеткирүү боюнча накталай акча\n\n` : `💵 Способ оплаты: Наличными при получении\n\n`;
    }

    if (userState.preparation_time === 'specific' && userState.specific_time) {
      costMessage += lan === 'kg' ? `⏰ Бышыруу убактысы: ${userState.specific_time}\n` : `⏰ Время приготовления: ${userState.specific_time}\n`;
    } else {
      costMessage += lan === 'kg' ? `⏰ Даярдоо убактысы: мүмкүн болушунча тезирээк\n` : `⏰ Время приготовления: как можно скорее\n`;
    }

    if (userState.promo_code) costMessage += `🎫 Промокод: ${userState.promo_code}\n`;
    if (userState.comment) costMessage += `📝 Комментарий: ${userState.comment}\n`;

    costMessage += lan === 'kg' ? `💰 Жалпы наркы: ${finalAmount} сом\n\n` : `💰 Общая стоимость: ${finalAmount} KGS\n\n`;
    if (userState.payment_method === 'transfer') {
      costMessage += lan === 'kg' ? `💳 Төлөө ыкмасы: Которуу, QR кодун жөнөтүү...\n` : `💳 Способ оплаты: Перевод, оправка QR кода...\n`;
    } else {
      costMessage += lan === 'kg' ? `⏳ Буйрутмаңыз иштетилүүдө...` : `⏳ Оформляем ваш заказ...`;
    }

    await sendMessage(phone_no_id, from, costMessage);

    if (userState.payment_method === 'transfer') {
      const userOrders = { orderItems, customerData, locationId, locationTitle, orderType, finalAmount };
      await setUserOrder(from, userOrders);
      await sendPaymentQRCodeImproved(phone_no_id, from, finalAmount);
    }

    await submitOrder(phone_no_id, from, orderItems, customerData, locationId, locationTitle, orderType, finalAmount, utensils_count);
  } catch (error) {
    const desc = (error.response?.data?.error?.description || "").toLowerCase();
  const type = (error.response?.data?.error?.type || "").toLowerCase();
  const status = error.response?.status;

  const { code, minAmount, description } = classifyPreorderError(error);
  const t = (ru, kg) => (lan) === 'ru' ? ru : kg;

  if (code === ERR.MIN_AMOUNT) {
    const need = (minAmount && itemsAmount) ? Math.max(minAmount - itemsAmount, 0) : null;
    let msg = t('❌ Для доставки не хватает суммы заказа.\n\n', '❌ Жеткируу үчүн сумма жетишсиз.\n\n');
    if (minAmount) msg += t(`Минимум для доставки: ${minAmount} KGS\n`, `Жеткируу минималдуу: ${minAmount} KGS\n`);
    if (need)    msg += t(`Не хватает: ${need} KGS\n\n`, `Жетпейт: ${need} KGS\n\n`);
    msg += t('Добавьте блюда в корзину или выберите самовывоз.',
             'Дагы тамак кошуңуз же өзү алып кетүүнү тандаңыз.');
    await sendMessage(phone_no_id, from, msg);
    await sendCatalog(phone_no_id, from);
    await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
    return;
  }

  // 1) Филиал закрыт
  if (desc.includes("location is closed") || type === "locationisclosedexception") {
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

  // 2) Товары закончились / недоступны
  if (desc.includes("out of stock") || desc.includes("unavailable") || type === "soldoutproductexception") {
    const ids = error.response?.data?.error?.productIds || [];
    const unavailable = ids
      .map(pid => orderItems.find(o => o.id === pid)?.title)
      .filter(Boolean)
      .join("\n");

    let msg;
    if (lan === "kg") {
      msg = `❌ Тилекке каршы, айрым товарлар азыр жок.\n\n` +
            (unavailable ? `${unavailable}\n\n` : "") +
            `Каталогдон башка тамактарды тандаңыз же менеджерге кайрылыңыз.`;
    } else {
      msg = `❌ К сожалению, некоторые позиции сейчас недоступны.\n\n` +
            (unavailable ? `${unavailable}\n\n` : "") +
            `Выберите альтернативы в каталоге или свяжитесь с менеджером.`;
    }
    await sendMessage(phone_no_id, from, msg);
    await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
    await sendCatalog(phone_no_id, from);
    return;
  }

  // 3) Типовые статусы HTTP
  if (status === 400) {
    await sendMessage(
      phone_no_id,
      from,
      lan === "kg"
        ? "❌ Заказ маалыматтарында ката. Кайра берип көрүңүз."
        : "❌ Ошибка в данных заказа. Попробуйте оформить заново."
    );
  } else if (status === 404) {
    await sendMessage(
      phone_no_id,
      from,
      lan === "kg"
        ? "❌ Тандалган филиал жеткиликсиз. Кийинчерээк аракет кылыңыз."
        : "❌ Выбранный филиал недоступен. Попробуйте позже."
    );
  } else if (status === 500) {
    console.error(`Технические неполадки на сервере: ${error.response?.data?.error?.description || error.message || "Unknown error"}`)
    await sendMessage(
      phone_no_id,
      from,
      lan === "kg"
        ? "❌ Серверде техникалык көйгөйлөр. Бир аздан кийин аракет кылыңыз."
        : "❌ Технические неполадки на сервере. Повторите попытку позже."
    );
  } else {
    // 4) Общий фолбэк
    const txt = error.response?.data?.error?.description || error.message || "Unknown error";
    await sendMessage(
      phone_no_id,
      from,
      lan === "kg"
        ? `❌ Заказ берүүдө ката: ${txt}`
        : `❌ Ошибка оформления заказа: ${txt}`
    );
  }
    // await sendMessage(phone_no_id, from, `❌ Критическая ошибка при оформлении заказа. Свяжитесь с менеджером ${contact_branch['1']}.`);
    await deleteUserState(from);
    await deleteUserOrders(from);
    await clearUserWaitingState(from);
  }
}

function classifyPreorderError(error) {
  const data = error?.response?.data || {};
  const e = data.error || {};
  const type = String(e.type || '').toUpperCase();
  const desc = String(e.description || data.message || '').toLowerCase();

  let code = null, minAmount = e.minOrderAmount || e.minOrderSum || null;

  if (type.includes('DELIVERYNOTAVAILABLEFORAMOUNTEXCEPTION') ||
      desc.includes('not available for amount'))
    code = ERR.MIN_AMOUNT;

  if (!minAmount) {
    const m = /(min(?:imum)?\s*(?:order)?\s*(?:sum|amount)\D+(\d+))/i.exec(e.description || '');
    if (m) minAmount = Number(m[2]);
  }

  return { code, minAmount, description: e.description || '' };
}

// ---------------------------- Payment QR ----------------------------
async function sendPaymentQRCodeImproved(phone_no_id, to, amount) {
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
  } catch {
    const paymentPhone = "+996709063676";
    const paymentRecipient = "ЭМИРЛАН Э.";
    const fallbackMessage = lan === 'kg'
      ? `💳 Которуу аркылуу төлөө:\n\n📱 ${paymentPhone}\n👤 ${paymentRecipient}\n\n💰 Төлөнө турган сумма: ${amount} KGS\n`
      : `💳 Оплата переводом:\n\n📱 ${paymentPhone}\n👤 ${paymentRecipient}\n\n💰 Сумма к оплате: ${amount} KGS\n`;
    await sendMessage(phone_no_id, to, fallbackMessage);
  }
}

// ---------------------------- Submit order ----------------------------
async function submitOrder(phone_no_id, from, orderItems, customerData, locationId, locationTitle, orderType, finalAmount, utensils_count) {
  const lan = await getUserLan(from);
  try {
    const preorderData = {
      locationId: parseInt(locationId),
      locationTitle,
      type: orderType,
      customerContact: {
        firstName: "Test",
        comment: (utensils_count && utensils_count !== '0') ? `Test\nКоличество приборов: ${utensils_count}` : `Test`,
        contactMethod: { type: "phoneNumber", value: from }
      },
      orderDueDateDelta: 0,
      guests: [{ orderItems }],
      paymentSumWithDiscount: null
    };

    const preorderResponse = await axios.post(
      `${TEMIR_API_BASE}/qr/preorder/?qr_token=${customerData.qr_access_token}`, preorderData
    );

    console.log(`ERROR ORDER IS: ${preorderResponse.status}`)

    console.log(`ERROR ORDER IS 2 : ${preorderResponse.data}`)

    console.log(`ERROR ORDER IS 2 : ${preorderResponse.data.error}`)
    
    console.log('ERROR ORDER IS 2 :', JSON.stringify(preorderResponse.data, null, 2));

    if (preorderResponse.data?.error) {
      throw { response: { status: 200, data: preorderResponse.data } };
    }

    await sendOrderSuccessMessage(phone_no_id, from, preorderResponse.data, orderType, finalAmount, locationTitle, locationId);
  } catch (error) {
  // локализация уже есть выше: const lan = await getUserLan(from);
  const desc = (error.response?.data?.error?.description || "").toLowerCase();
  const type = (error.response?.data?.error?.type || "").toLowerCase();
  const status = error.response?.status;

  // 1) Филиал закрыт
  if (desc.includes("location is closed") || type === "locationisclosedexception") {
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

  // 2) Товары закончились / недоступны
  if (desc.includes("out of stock") || desc.includes("unavailable") || type === "soldoutproductexception") {
    const ids = error.response?.data?.error?.productIds || [];
    const unavailable = ids
      .map(pid => orderItems.find(o => o.id === pid)?.title)
      .filter(Boolean)
      .join("\n");

    let msg;
    if (lan === "kg") {
      msg = `❌ Тилекке каршы, айрым товарлар азыр жок.\n\n` +
            (unavailable ? `${unavailable}\n\n` : "") +
            `Каталогдон башка тамактарды тандаңыз же менеджерге кайрылыңыз.`;
    } else {
      msg = `❌ К сожалению, некоторые позиции сейчас недоступны.\n\n` +
            (unavailable ? `${unavailable}\n\n` : "") +
            `Выберите альтернативы в каталоге или свяжитесь с менеджером.`;
    }
    await sendMessage(phone_no_id, from, msg);
    await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
    await sendCatalog(phone_no_id, from);
    return;
  }

  // 3) Типовые статусы HTTP
  if (status === 400) {
    await sendMessage(
      phone_no_id,
      from,
      lan === "kg"
        ? "❌ Заказ маалыматтарында ката. Кайра берип көрүңүз."
        : "❌ Ошибка в данных заказа. Попробуйте оформить заново."
    );
  } else if (status === 404) {
    await sendMessage(
      phone_no_id,
      from,
      lan === "kg"
        ? "❌ Тандалган филиал жеткиликсиз. Кийинчерээк аракет кылыңыз."
        : "❌ Выбранный филиал недоступен. Попробуйте позже."
    );
  } else if (status === 500) {
    await sendMessage(
      phone_no_id,
      from,
      lan === "kg"
        ? "❌ Серверде техникалык көйгөйлөр. Бир аздан кийин аракет кылыңыз."
        : "❌ Технические неполадки на сервере. Повторите попытку позже."
    );
  } else {
    // 4) Общий фолбэк
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
  try {
    const response = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
    const restaurants = response.data;
    const branch = restaurants.find(r => r.external_id.toString() === branchId);
    if (branch) {
      return {
        id: branch.external_id,
        title: branch.title,
        address: branch.address,
        phone: branch.contacts.find(c => c.type === 'PHONE')?.value,
        whatsapp: branch.contacts.find(c => c.type === 'WHATSAPP')?.value
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------- Simple answers ----------------------------
async function sendOrderStatusResponse(phone_no_id, from, language) {
  const m = language === 'kg'
    ? `📋 Буйрутмаңыздын статусу жөнүндө:\n\nСиздин WhatsApp'ка буйрутмаңыздын статусу жөнүндө билдирүү жөнөтүлөт.`
    : `📋 О статусе заказа:\n\nВам будет отправлено уведомление в WhatsApp о статусе заказа.`;
  await sendMessage(phone_no_id, from, m);
}
async function sendOrderTrackingResponse(phone_no_id, from, language) {
  const m = language === 'kg'
    ? `📱 Буйрутманы көзөмөлдөө:\n\nСиздин WhatsApp'ка буйрутмаңыздын статусу жөнүндө билдирүү жөнөтүлөт.`
    : `📱 Отслеживание заказа:\n\nВам будет отправлено уведомление в WhatsApp о статусе заказа.`;
  await sendMessage(phone_no_id, from, m);
}
async function sendPickupAddressResponse(phone_no_id, from, language) {
  const m = language === 'kg'
    ? `📍 Алып кетүү дареги:\n\n🏪 **Yaposhkin Rolls**\nИсы Ахунбаева 125в\nБишкек, көчөсү Исы Ахунбаева, 125А\n📞 +996709063676\n🕐 Күн сайын 11:00 - 23:45\n\n🏪 **Yaposhkin Rolls Кок жар**\nБишкек, көчөсү Чар, 83\n📞 +996705063676\n🕐 Күн сайын 11:00 - 23:45`
    : `📍 Адреса для самовывоза:\n\n🏪 **Yaposhkin Rolls**\nИсы Ахунбаева 125в\nБишкек, улица Исы Ахунбаева, 125А\n📞 +996709063676\n🕐 Ежедневно 11:00 - 23:45\n\n🏪 **Yaposhkin Rolls Кок жар**\nБишкек, улица Чар, 83\n📞 +996705063676\n🕐 Ежедневно 11:00 - 23:45`;
  await sendMessage(phone_no_id, from, m);
}
async function sendMenuResponse(phone_no_id, from, language) {
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
    for (const p of possiblePaths) if (fs.existsSync(p)) { menuPdfPath = p; break; }
    if (!menuPdfPath) throw new Error('PDF not found');

    await sendLocalPdfDocument(phone_no_id, from, menuPdfPath, {
      document: {
        filename: language === 'kg' ? "Yaposhkin_Rolls_Menu_KG.pdf" : "Yaposhkin_Rolls_Menu_RU.pdf",
        caption: language === 'kg' ? "📋 Yaposhkin Rolls меню" : "📋 Меню Yaposhkin Rolls"
      }
    });
  } catch {
    const fallbackMessage = language === 'kg'
      ? `🍽️ Биздин менюда бар:\n\n🍣 Роллдор жана суши\n🍱 Сеттер\n🥗 Салаттар\n🍜 Ысык тамактар\n🥤 Суусундуктар\n\nТолук маалымат үчүн менеджер:\n📞 +996709063676`
      : `🍽️ В нашем меню есть:\n\n🍣 Роллы и суши\n🍱 Сеты\n🥗 Салаты\n🍜 Горячие блюда\n🥤 Напитки\n\nПолная информация у менеджера:\n📞 +996709063676`;
    await sendMessage(phone_no_id, from, fallbackMessage);
  }
}
async function sendLocalPdfDocument(phone_no_id, from, filePath, documentMessage) {
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

    const uploadResponse = await axios.post(
      `https://graph.facebook.com/v22.0/${phone_no_id}/media`,
      formData,
      { headers: { 'Authorization': `Bearer ${token}`, ...formData.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity }
    );

    const mediaId = uploadResponse.data.id;
    const data = {
      messaging_product: "whatsapp",
      to: from,
      type: "document",
      document: { id: mediaId, filename: documentMessage.document.filename, caption: documentMessage.document.caption }
    };
    await sendWhatsAppMessage(phone_no_id, data);
  } catch {
    await sendMessage(phone_no_id, from, "Не удалось отправить меню. Откроем каталог:");
    await sendCatalog(phone_no_id, from);
  }
}

async function sendOrderForAnotherResponse(phone_no_id, from, language) {
  const m = language === 'kg'
    ? `👥 Башка адамга буйрутма берүү:\n\nСиз башка адамга буйрутма бере аласыз, анын аты-жөнүн жана номерин көрсөтүп. Ошондой эле, жеткирүү дарегин жазууну унутпаңыз.`
    : `👥 Заказ на другого человека:\n\nМожно оформить заказ на другого, указав его имя и номер. Также не забудьте вписать нужный адрес доставки (если не самовывоз).`;
  await sendMessage(phone_no_id, from, m);
}
async function sendPaymentMethodResponse(phone_no_id, from, language) {
  const m = language === 'kg'
    ? `💳 Төлөө жолдору:\n\nОоба, карта менен төлөсө болот.`
    : `💳 Способы оплаты:\n\nДа, можно оплатить картой.`;
  await sendMessage(phone_no_id, from, m);
}
async function sendManagerContactMessage(phone_no_id, from, language) {
  const m = language === 'kg'
    ? `Саламатсызбы!\n\nБул суроолор боюнча биздин кызматкер менен байланышсаңыз болот:\n📱 +996709063676`
    : `Здравствуйте!\n\nПо этим вопросам можно связаться с нашим сотрудником:\n📱 +996709063676`;
  await sendMessage(phone_no_id, from, m);
}

// ---------------------------- Order success ----------------------------
async function sendOrderSuccessMessage(phone_no_id, from, preorderResponse, orderType, finalAmount, locationTitle, locationId) {
  const lan = await getUserLan(from);
  try {
    let successMessage = '';
    if (preorderResponse.status === 'success') {
      successMessage = lan === 'kg'
        ? '🎉 Буйрутмаңыз кабыл алынды!\n\n'
        : '🎉 Ваш заказ принят!\n\n';
      // successMessage += lan === 'kg'
      //   ? `📋 Буйрутма номери: ${preorderResponse.data.preorder_id}\n\n`
      //   : `📋 Номер заказа: ${preorderResponse.data.preorder_id}\n\n`;

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
    } else {
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
  } catch (error){
    console.log(`ошибка формление ${error.message}`)
    await deleteUserState(from);
    await clearUserWaitingState(from);
  }
}

// ---------------------------- Flow encryption endpoint ----------------------------
app.post("/flow", async (req, res) => {
  try {
    const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptRequest(req.body);
    const responseData = await processFlowData(decryptedBody);
    const encryptedResponse = encryptResponse(responseData, aesKeyBuffer, initialVectorBuffer);
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(encryptedResponse);
  } catch {
    return res.status(421).json({ error: "Request processing failed" });
  }
});

const decryptRequest = (body) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;
  const privatePem = getPrivateKey();
  if (!privatePem) throw new Error("Private key not found");

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

  return { decryptedBody: JSON.parse(decryptedJSONString), aesKeyBuffer: decryptedAesKey, initialVectorBuffer };
};

const encryptResponse = (response, aesKeyBuffer, initialVectorBuffer) => {
  const flipped_iv = [];
  for (const pair of initialVectorBuffer.entries()) flipped_iv.push(~pair[1]);
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKeyBuffer, Buffer.from(flipped_iv));
  const encryptedData = Buffer.concat([cipher.update(JSON.stringify(response), "utf-8"), cipher.final(), cipher.getAuthTag()]);
  return encryptedData.toString("base64");
};

async function processFlowData(data) {
  try {
    const { action, flow_token, data: flowData, screen } = data;
    switch (action) {
      case "ping":
        return { data: { status: "active" } };
      case "INIT":
        if (flow_token && flow_token.includes("new_customer")) {
          return { screen: "WELCOME_NEW", data: { flow_type: "new_customer", branches: flowData?.branches || [] } };
        } else if (flow_token && flow_token.includes("existing_customer")) {
          const customerName = flowData?.customer_name || "";
          const userAddresses = flowData?.user_addresses || [];
          const branches = flowData?.branches || [];
          return { screen: "ORDER_TYPE", data: { flow_type: "existing_customer", customer_name: customerName, user_addresses: userAddresses, branches } };
        }
        return { screen: "ORDER_TYPE", data: {} };
      case "data_exchange":
        return await handleDataExchange(screen, flowData, flow_token);
      default:
        return { data: { status: "active" } };
    }
  } catch {
    return { data: { status: "active" } };
  }
}

async function handleDataExchange(screen, data, flow_token) {
  try {
    switch (screen) {
      case "WELCOME_NEW":
        return { screen: "ORDER_TYPE_NEW", data: { flow_type: "new_customer", customer_name: data.customer_name, branches: data.branches } };
      case "ORDER_TYPE_NEW":
        return { screen: "DELIVERY_OPTIONS_NEW", data: { flow_type: "new_customer", customer_name: data.customer_name, order_type: data.order_type, branches: data.branches } };
      case "DELIVERY_OPTIONS_NEW":
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
        return { screen: "DELIVERY_OPTIONS", data: { flow_type: "existing_customer", customer_name: data.customer_name, order_type: data.order_type, user_addresses: data.user_addresses, branches: data.branches } };
      case "DELIVERY_OPTIONS":
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
        return { screen: "ORDER_TYPE", data: {} };
    }
  } catch {
    return { screen, data: { error_message: "Произошла ошибка. Попробуйте еще раз." } };
  }
}

function getPrivateKey() {
  try {
    if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY.replace(/\\n/g, '\n');
    if (fs.existsSync('./private_key.pem')) return fs.readFileSync('./private_key.pem', 'utf8');
    return null;
  } catch {
    return null;
  }
}

// ---------------------------- Order status notify API ----------------------------
app.post("/order-status", async (req, res) => {
  try {
    const { phone, order_id, status, order_type, location_title, estimated_time, additional_info } = req.body;
    if (!phone || !order_id || !status) return res.status(400).json({ success: false, error: "Обязательные поля: phone, order_id, status" });

    const phone_no_id = process.env.PHONE_NUMBER_ID;
    if (!phone_no_id) return res.status(500).json({ success: false, error: "PHONE_NUMBER_ID не настроен" });

    const result = await sendOrderStatusNotification(
      phone_no_id, phone, order_id, status, order_type, location_title, estimated_time, additional_info
    );

    if (result.success) res.status(200).json({ success: true, message: "Уведомление отправлено", whatsapp_message_id: result.message_id });
    else res.status(500).json({ success: false, error: result.error });
  } catch {
    res.status(500).json({ success: false, error: "Внутренняя ошибка сервера" });
  }
});

async function sendOrderStatusNotification(phone_no_id, customerPhone, orderId, status, orderType = 'pickup', locationTitle = '', estimatedTime = '', additionalInfo = '') {
  try {
    const message = await formatOrderStatusMessage(orderId, status, orderType, locationTitle, estimatedTime, additionalInfo, customerPhone.replace("+", ""));
    const response = await sendMessage(phone_no_id, customerPhone.replace("+", ""), message);
    return { success: true, message_id: response.messages?.[0]?.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// async function formatOrderStatusMessage(orderId, status, orderType, locationTitle, estimatedTime, additionalInfo, from) {
//   const lan = await getUserLan(from);
//   const userState = await getUserState(from);

//   let message = lan === 'ru' ? `📋 Заказ №${orderId}\n` : `📋 Буйрутма №${orderId}\n`;

//   switch (status.toLowerCase()) {
//     case 'accepted':
//     case 'подтвержден':
//       message += lan === 'ru' ? `✅ Ваш заказ подтвержден и принят в работу!\n\n` : `✅ Буйрутмаңыз ырасталды жана иштетүүгө кабыл алынды!\n\n`;
//       break;
//     case 'production':
//     case 'отправлен на кухню':
//       message += lan === 'ru' ? `👨‍🍳 Наши повара готовят ваш заказ!\n\n` : `👨‍🍳 Биздин ашпозчулар буйрутмаңызды даярдап жатышат!\n\n`;
//       break;
//     case 'out_for_delivery':
//     case 'в_доставке':
//       message += `🚗 Курьер в пути!\n\n📍 Ваш заказ доставляется по указанному адресу.\n`;
//       break;
//     case 'delivered':
//     case 'доставлен':
//       message += `✅ Заказ успешно доставлен!\n\n🙏 Спасибо за выбор Yaposhkin Rolls!\n`;
//       break;
//     case 'completed':
//     case 'выполнен':
//       if (lan === 'ru') {
//         if (userState?.order_type === 'delivery') {
//           message += `🎉 Ваш заказ готов и передан курьеру!\n\n🙏 Спасибо за выбор Yaposhkin Rolls!\n`;
//         } else {
//           message += `🎉 Ваш заказ готов к выдаче!\n\n🙏 Спасибо за выбор Yaposhkin Rolls!\n`;
//         }
//       } else {
//         if (userState?.order_type === 'delivery') {
//           message += `🎉 Буйрутмаңыз даяр жана курьерге берилди!\n\n🙏 Yaposhkin Rolls тандаганыңыз үчүн рахмат!\n`;
//         } else {
//           message += `🎉 Буйрутмаңыз алып кетүүгө даяр!\n\n🙏 Yaposhkin Rolls тандаганыңыз үчүн рахмат!\n`;
//         }
//       }
//       await deleteUserState(from);
//       await clearUserWaitingState(from);
//       break;
//     case 'cancelled':
//     case 'отменен':
//       message += lan === 'ru'
//         ? `❌ Заказ отменен\n\n😔 Приносим извинения за неудобства.\n`
//         : `❌ Буйрутма жокко чыгарылды\n\n😔 Ыңгайсыздык үчүн кечирим сурайбыз.\n`;
//       await deleteUserState(from);
//       await clearUserWaitingState(from);
//       break;
//     case 'delayed':
//     case 'задержан':
//       message += `⏰ Небольшая задержка заказа\n\n`;
//       if (estimatedTime) message += `🕐 Новое ожидаемое время: ${estimatedTime}\n`;
//       if (additionalInfo) message += `📝 Причина: ${additionalInfo}\n`;
//       break;
//     default:
//       message += `📋 Статус заказа обновлен: ${status}\n\n`;
//   }
//   return message;
// }

async function formatOrderStatusMessage(orderId, status, orderType, locationTitle, estimatedTime, additionalInfo, from) {
  const lan = await getUserLan(from);
  const userState = await getUserState(from);
  // const S = normalizeStatus(status);
  const ordType = userState?.order_type;

  let m = '';
  // let m = lan === 'ru' ? `📋 Заказ №${orderId}\n` : `📋 Буйрутма №${orderId}\n`;

  switch (status) {
    case 'NEW':
      m += lan === 'ru' ? '📝 Заказ создан. Ожидает подтверждения.\n\n'
                        : '📝 Буйрутма түзүлдү. Ырастоону күтүп жатат.\n\n';
      break;
    case 'ACCEPTED':
      m += lan === 'ru' ? '✅ Заказ принят в работу.\n\n'
                        : '✅ Буйрутма иштетүүгө кабыл алынды.\n\n';
      break;
    case 'PRODUCTION':
      m += lan === 'ru' ? '👨‍🍳 Заказ готовится.\n\n'
                        : '👨‍🍳 Буйрутма даярдалууда.\n\n';
      break;
    case 'COMPLETED':
      if (ordType === 'delivery') {
        m += lan === 'ru' ? '🎉 Заказ готов. Ожидайте доставку.\n\n'
                          : '🎉 Буйрутма даяр. Жеткирүү күтүлүүдө.\n\n';
      } else {
        m += lan === 'ru' ? '🎉 Заказ готов к выдаче.\n\n'
                          : '🎉 Буйрутма алып кетүүгө даяр.\n\n';
      }
      break;
    case 'OUT_FOR_DELIVERY':
      m += lan === 'ru' ? '🚗 Курьер в пути.\n\n'
                        : '🚗 Курьер жолдо.\n\n';
      break;
    case 'DELIVERED':
    case 'DONE':
      m += lan === 'ru' ? '✅ Заказ успешно выполнено. Спасибо.\n'
                        : '✅ Буйрутма ийгиликтүү аткарылды. Рахмат.\n';
      await deleteUserState(from);
      await clearUserWaitingState(from);
      break;
    case 'CANCELLED':
      m += lan === 'ru' ? '❌ Заказ отменен.\n'
                        : '❌ Буйрутма жокко чыгарылды.\n';
      await deleteUserState(from);
      await clearUserWaitingState(from);
      break;
    case 'DELAYED':
      m += lan === 'ru' ? '⏰ Небольшая задержка.\n'
                        : '⏰ Кичине кечигүү.\n';
      if (estimatedTime) m += `🕐 ${estimatedTime}\n`;
      if (additionalInfo) m += `📝 ${additionalInfo}\n`;
      break;
    default:
      m += lan === 'ru' ? `📋 Статус: ${status}\n`
                        : `📋 Статус: ${status}\n`;
  }
  return m;
}

// ---------------------------- Stats / Cleanup / Root ----------------------------
app.get("/stats", async (_req, res) => {
  try {
    const totalUsers = await userStatesCollection.countDocuments();
    const waitingStates = await userStatesCollection.aggregate([{ $group: { _id: "$waitingState", count: { $sum: 1 } } }]).toArray();
    const agg = waitingStates.reduce((acc, i) => { acc[i._id || 'none'] = i.count; return acc; }, {});
    res.status(200).json({ success: true, timestamp: new Date().toISOString(), database: { connected: !!db, name: DB_NAME }, statistics: { totalUsers, waitingStates: agg } });
  } catch {
    res.status(500).json({ success: false, error: "Ошибка получения статистики" });
  }
});

app.delete("/cleanup", async (_req, res) => {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await userStatesCollection.deleteMany({ updatedAt: { $lt: oneDayAgo } });
    res.status(200).json({ success: true, message: `Удалено ${result.deletedCount} старых состояний`, deletedCount: result.deletedCount });
  } catch {
    res.status(500).json({ success: false, error: "Ошибка очистки состояний" });
  }
});

app.get("/", (_req, res) => {
  res.status(200).json({
    message: "WhatsApp Bot с MongoDB",
    status: "active",
    version: "2.1.0",
    database: { connected: !!db, name: DB_NAME },
    features: [
      "MongoDB состояния",
      "Flow обработка",
      "Каталог товаров",
      "Уведомления о заказах",
      "AI-помощь в середине оформления заказа",
      "Возобновление процесса (resume checkpoint)"
    ],
    endpoints: { webhook: "/webhook", flow: "/flow", orderStatus: "/order-status", stats: "/stats", cleanup: "/cleanup" }
  });
});

// ---------------------------- Process signals ----------------------------
process.on('SIGINT', async () => {
  if (db) await db.client.close();
  process.exit(0);
});
process.on('unhandledRejection', (reason) => { console.error('unhandledRejection:', reason); });
process.on('uncaughtException', (error) => { console.error('uncaughtException:', error); process.exit(1); });
