const { generateText } = require('ai');
const { openai } = require('@ai-sdk/openai');
const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const { MongoClient } = require('mongodb');
const { time } = require("console");
const path = require('path');

const PORT = process.env.PORT || 3500;

const app = express().use(body_parser.json());

const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN;

// Конфигурация
const TEMIR_API_BASE = 'https://ya.temir.me';

// Flow IDs
const NEW_CUSTOMER_FLOW_ID = '822959930422520'; // newCustomer
const ORDER_FLOW_ID = '1265635731924331'; // order
const NEW_CUSTOMER_FLOW_ID_KY = '762432499878824'; // newCustomer
const ORDER_FLOW_ID_KY = '769449935850843'; // order 


// MongoDB конфигурация
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'whatsapp_bot';
let db = null;
let userStatesCollection = null;
let userDataForOrderCollection = null;

// Возможные состояния ожидания
const WAITING_STATES = {
    NONE: 'none',                    // Принимаем любые сообщения
    LANG: 'lang',
    FLOW_RESPONSE: 'flow_response',  // Ожидаем ответ от Flow
    LOCATION: 'location',            // Ожидаем местоположение
    CATALOG_ORDER: 'catalog_order',   // Ожидаем ответ от каталога
    ORDER_STATUS : 'order-status'
    // PAYMENT_CONFIRMATION: 'payment_confirmation'
};

const contact_branch = {
    '1' : '0709063676',
    '15' : '0705063676'
}

async function analyzeCustomerIntent(messageText) {
    try {
        console.log("🤖 Анализируем намерение клиента с GPT-4o:", messageText);
        
        const { text } = await generateText({
            model: openai('gpt-4o'),
            messages: [
                {
                    role: 'system',
                    content: `Ты эксперт-аналитик намерений клиентов ресторана японской кухни "Yaposhkin Rolls".

🎯 ГЛАВНАЯ ЗАДАЧА: Определить намерение клиента из следующих категорий:
1. ORDER_INTENT - хочет заказать еду
2. ORDER_STATUS - спрашивает о статусе заказа 
3. ORDER_TRACKING - как отслеживать заказ
4. PICKUP_ADDRESS - спрашивает адреса филиалов для самовывоза
5. MENU_QUESTION - спрашивает о меню (сеты, пицца, бургеры, картошка фри)
6. ORDER_FOR_ANOTHER - заказ на другого человека
7. PAYMENT_METHOD - способы оплаты картой
8. OTHER_INTENT - все остальные вопросы

📋 КОНТЕКСТ: Клиенты пишут в WhatsApp бот ресторана роллов и суши.

🌐 ЯЗЫКИ: Анализируй сообщения на русском и кыргызском языках с высокой точностью.

✅ ORDER_INTENT (заказ еды) - если клиент:
• Хочет заказать: "заказ", "хочу заказать", "буду заказывать", "оформить заказ"
• Кыргызский: "буйрутма", "буйрутма берүү", "заказ кылгым келет", "тапшырма берүү"
• Интересуется едой: "меню", "каталог", "роллы", "суши", "что есть", "посмотреть блюда"
• Кыргызский: "меню", "каталог", "роллдор", "суши", "эмне бар", "тамактарды көрүү"
• Доставка: "доставка", "привезите", "доставить", "жеткирүү", "алып келиңиз"
• Приветствие + еда: "привет, голодный", "салам, ачка болдум"
• Эмодзи еды: 🍣🍱🍜🥢🍤
• Просто приветствие в контексте ресторана

🔍 ORDER_STATUS (статус заказа) - если клиент спрашивает:
• "когда будет готов заказ", "готов ли заказ", "статус заказа", "где мой заказ"
• "сколько ждать", "через сколько будет готово", "готовится ли заказ"
• Кыргызский: "заказ качан даяр болот", "буйрутма даярбы", "канча күтүү керек"

📱 ORDER_TRACKING (отслеживание заказа) - если клиент спрашивает:
• "как отслеживать заказ", "как узнать статус", "где посмотреть статус заказа"
• "как получать уведомления", "будет ли уведомление"
• Кыргызский: "заказды кантип көзөмөлдөө", "статусту кайдан билүү"

📍 PICKUP_ADDRESS (адреса самовывоза) - если клиент спрашивает:
• "адрес самовывоза", "где находитесь", "адреса филиалов", "откуда забирать"
• "где ваши точки", "адреса ресторанов", "куда приехать за заказом"
• Кыргызский: "алып кетүү дареги", "кайда жайгашкансыздар", "филиалдардын дареги"

🍽️ MENU_QUESTION (вопросы о меню) - если клиент спрашивает:
• "есть ли сеты", "есть ли пицца", "есть ли бургеры", "есть ли картошка фри"
• "что в меню", "какие блюда есть", "полное меню"
• Кыргызский: "сеттер барбы", "пицца барбы", "менюда эмне бар"

👥 ORDER_FOR_ANOTHER (заказ на другого) - если клиент спрашивает:
• "заказ на другого человека", "можно ли заказать на имя друга"
• "оформить заказ не на себя", "заказ для кого-то"
• Кыргызский: "башка адамга заказ", "досума заказ кылсам болобу"

💳 PAYMENT_METHOD (способы оплаты) - если клиент спрашивает:
• "оплата картой", "можно ли картой", "принимаете карты", "онлайн оплата"
• "способы оплаты", "как оплатить", "терминал есть"
• Кыргызский: "карта менен төлөсө болобу", "төлөө жолдору", "онлайн төлөө"

❌ OTHER_INTENT (другие вопросы) - если клиент:
• Режим работы (не связанный с адресами): "часы работы", "когда работаете", "график"
• Общие жалобы: "плохо", "невкусно", "проблема", "жалоба"
• Общие вопросы: "что это", "кто вы", "информация о компании"
• Другие темы не связанные с заказом, статусом, адресами, меню, оплатой

🎯 ФОРМАТ ОТВЕТА (строго):
ORDER_INTENT|ru - для заказа на русском
ORDER_INTENT|kg - для заказа на кыргызском  
ORDER_STATUS|ru - вопрос о статусе заказа на русском
ORDER_STATUS|kg - вопрос о статусе заказа на кыргызском
ORDER_TRACKING|ru - вопрос об отслеживании на русском
ORDER_TRACKING|kg - вопрос об отслеживании на кыргызском
PICKUP_ADDRESS|ru - вопрос об адресах на русском
PICKUP_ADDRESS|kg - вопрос об адресах на кыргызском
MENU_QUESTION|ru - вопрос о меню на русском
MENU_QUESTION|kg - вопрос о меню на кыргызском
ORDER_FOR_ANOTHER|ru - заказ на другого на русском
ORDER_FOR_ANOTHER|kg - заказ на другого на кыргызском
PAYMENT_METHOD|ru - вопрос об оплате на русском
PAYMENT_METHOD|kg - вопрос об оплате на кыргызском
OTHER_INTENT|ru - другие вопросы на русском
OTHER_INTENT|kg - другие вопросы на кыргызском

📝 ПРИМЕРЫ:
"Привет, хочу роллы заказать" → ORDER_INTENT|ru
"Когда будет готов мой заказ?" → ORDER_STATUS|ru
"Как отслеживать статус заказа?" → ORDER_TRACKING|ru
"Подскажите адрес для самовывоза" → PICKUP_ADDRESS|ru
"Есть ли у вас пицца?" → MENU_QUESTION|ru
"Можно заказать на другого человека?" → ORDER_FOR_ANOTHER|ru
"Можно оплатить картой?" → PAYMENT_METHOD|ru
"Салам аке, буйрутма кылгым келет" → ORDER_INTENT|kg
"Канча убакытта иштейсиздер?" → OTHER_INTENT|kg`
                },
                {
                    role: 'user',
                    content: messageText
                }
            ],
            maxTokens: 20,
            temperature: 0.0
        });

        console.log("🤖 AI ответ:", text);
        
        // Парсим ответ
        const parts = text.trim().split('|');
        if (parts.length >= 2) {
            const intent = parts[0];
            const language = parts[1];
            
            return {
                intent: intent,
                isOrderIntent: intent === 'ORDER_INTENT',
                language: language,
                originalText: messageText
            };
        }
        
        // Fallback - считаем что хочет заказать
        return {
            intent: 'ORDER_INTENT',
            isOrderIntent: true,
            language: 'ru',
            originalText: messageText
        };
        
    } catch (error) {
        console.error("❌ Ошибка анализа намерения:", error);
        
        // Fallback анализ по ключевым словам
        return analyzeIntentFallback(messageText);
    }
}

// Fallback функция анализа намерения (если AI недоступен)
function analyzeIntentFallback(messageText) {
    console.log("🔄 Используем fallback анализ намерения");
    
    const text = messageText.toLowerCase();
    
    // Ключевые слова для заказа на русском
    const orderKeywordsRu = [
        'заказ', 'заказать', 'хочу', 'буду', 'доставка', 'доставить',
        'меню', 'каталог', 'роллы', 'суши', 'еда', 'поесть',
        'привет', 'здравствуйте', 'добрый', 'салют', '🍣', '🍱', '🍜'
    ];
    
    // Ключевые слова для заказа на кыргызском  
    const orderKeywordsKg = [
        'буйрутма', 'буйрутма', 'кылгым', 'берүү', 'жеткирүү',
        'меню', 'каталог', 'роллдор', 'суши', 'тамак', 'жеп',
        'салам', 'кандайсыз', 'жакшы', 'кутман'
    ]; 
    
    // Ключевые слова НЕ для заказа
    const otherKeywordsRu = [
        'часы работы', 'время работы', 'график', 'адрес', 'где находитесь',
        'телефон', 'контакты', 'жалоба', 'проблема', 'качество', 'не вкусно'
    ];
    
    const otherKeywordsKg = [
        'иш убактысы', 'канча убакытта', 'дарек', 'кайда жайгашкан',
        'телефон', 'байланыш', 'арыз', 'көйгөй', 'сапаты', 'жаман'
    ];
    
    // Определяем язык
    let language = 'ru';
    const hasKgWords = orderKeywordsKg.some(word => text.includes(word)) || 
                      otherKeywordsKg.some(word => text.includes(word));
    if (hasKgWords) {
        language = 'kg';
    }
    
    // Проверяем намерение заказа
    const hasOrderIntent = orderKeywordsRu.some(word => text.includes(word)) ||
                          orderKeywordsKg.some(word => text.includes(word));
    
    // Проверяем другие намерения
    const hasOtherIntent = otherKeywordsRu.some(word => text.includes(word)) ||
                          otherKeywordsKg.some(word => text.includes(word));
    
    return {
        isOrderIntent: hasOrderIntent && !hasOtherIntent,
        language: language,
        originalText: messageText
    };
}


// Функция для тестирования GPT-4o подключения
function analyzeIntentFallback(messageText) {
    console.log("🔄 Используем fallback анализ намерения");
    
    const text = messageText.toLowerCase();
    
    // Определяем язык
    let language = 'ru';
    const kgWords = ['буйрутма', 'заказ кылгым', 'салам', 'кандайсыз', 'качан', 'канча'];
    if (kgWords.some(word => text.includes(word))) {
        language = 'kg';
    }
    
    // Проверяем специфичные намерения
    
    // Статус заказа
    const statusKeywords = ['когда будет готов', 'готов ли заказ', 'статус заказа', 'где мой заказ', 'сколько ждать', 'заказ качан', 'буйрутма даярбы'];
    if (statusKeywords.some(word => text.includes(word))) {
        return { intent: 'ORDER_STATUS', isOrderIntent: false, language: language, originalText: messageText };
    }
    
    // Отслеживание заказа
    const trackingKeywords = ['как отслеживать', 'как узнать статус', 'отслеживание заказа', 'уведомления', 'кантип көзөмөлдөө'];
    if (trackingKeywords.some(word => text.includes(word))) {
        return { intent: 'ORDER_TRACKING', isOrderIntent: false, language: language, originalText: messageText };
    }
    
    // Адреса самовывоза
    const addressKeywords = ['адрес самовывоза', 'где находитесь', 'адреса филиалов', 'куда приехать', 'алып кетүү дареги'];
    if (addressKeywords.some(word => text.includes(word))) {
        return { intent: 'PICKUP_ADDRESS', isOrderIntent: false, language: language, originalText: messageText };
    }
    
    // Вопросы о меню
    const menuKeywords = ['есть ли сеты', 'есть ли пицца', 'есть ли бургеры', 'картошка фри', 'полное меню', 'сеттер барбы'];
    if (menuKeywords.some(word => text.includes(word))) {
        return { intent: 'MENU_QUESTION', isOrderIntent: false, language: language, originalText: messageText };
    }
    
    // Заказ на другого
    const anotherPersonKeywords = ['заказ на другого', 'не на себя', 'для кого-то', 'башка адамга'];
    if (anotherPersonKeywords.some(word => text.includes(word))) {
        return { intent: 'ORDER_FOR_ANOTHER', isOrderIntent: false, language: language, originalText: messageText };
    }
    
    // Способы оплаты
    const paymentKeywords = ['оплата картой', 'можно ли картой', 'принимаете карты', 'онлайн оплата', 'карта менен'];
    if (paymentKeywords.some(word => text.includes(word))) {
        return { intent: 'PAYMENT_METHOD', isOrderIntent: false, language: language, originalText: messageText };
    }
    
    // Ключевые слова для заказа
    const orderKeywords = ['заказ', 'заказать', 'хочу', 'буду', 'доставка', 'меню', 'каталог', 'роллы', 'суши', 'привет', 'здравствуйте', 'буйрутма', 'салам'];
    if (orderKeywords.some(word => text.includes(word))) {
        return { intent: 'ORDER_INTENT', isOrderIntent: true, language: language, originalText: messageText };
    }
    
    // Все остальное
    return { intent: 'OTHER_INTENT', isOrderIntent: false, language: language, originalText: messageText };
}

// Инициализация MongoDB
async function initMongoDB() {
    try {
        console.log("🔗 Подключаемся к MongoDB...");
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        
        db = client.db(DB_NAME);
        userStatesCollection = db.collection('user_states');
        userDataForOrderCollection = db.collection('user_orders');
        
        // Создаем индекс по phone для быстрого поиска
        await userStatesCollection.createIndex({ phone: 1 });
        await userDataForOrderCollection.createIndex({ phone: 1 });
        
        // TTL индекс для автоматического удаления старых записей (24 часа)
        await userStatesCollection.createIndex(
            { updatedAt: 1 }, 
            { expireAfterSeconds: 86400 }
        );

        await userDataForOrderCollection.createIndex(
            { updatedAt: 1 }, 
            { expireAfterSeconds: 86400 }
        );
        
        console.log("✅ MongoDB подключена успешно");
        console.log(`📊 База данных: ${DB_NAME}`);
        console.log(`📋 Коллекция: user_states`);
        
    } catch (error) {
        console.error("❌ Ошибка подключения к MongoDB:", error);
        process.exit(1);
    }
}

// Функции для работы с состояниями пользователей в MongoDB

// Получение состояния пользователя
async function getUserState(phone) {
    try {
        const userDoc = await userStatesCollection.findOne({ phone });
        return userDoc?.state || null;
    } catch (error) {
        console.error(`❌ Ошибка получения состояния пользователя ${phone}:`, error);
        return null;
    }
}

async function getUserLan(phone) {
    try {
        const userDoc = await userStatesCollection.findOne({ phone });
        return userDoc?.lan || null;
    } catch (error) {
        console.error(`❌ Ошибка получения состояния пользователя ${phone}:`, error);
        return null;
    }
}

async function getUserOrders(phone) {
    try {
        const userDoc = await userDataForOrderCollection.findOne({ phone });
        return userDoc?.state || null;
    } catch (error) {
        console.error(`❌ Ошибка получения заказа пользователя ${phone}:`, error);
        return null;
    }
}

// Сохранение состояния пользователя
async function setUserState(phone, state) {
    try {
        const now = new Date();
        await userStatesCollection.updateOne(
            { phone },
            {
                $set: {
                    phone,
                    state,
                    updatedAt: now
                },
                $setOnInsert: {
                    createdAt: now
                }
            },
            { upsert: true }
        );
        console.log(`💾 Состояние пользователя ${phone} сохранено`);
    } catch (error) {
        console.error(`❌ Ошибка сохранения состояния пользователя ${phone}:`, error);
    }
}

async function setUserOrder(phone, state) {
    try {
        const now = new Date();
        await userDataForOrderCollection.updateOne(
            { phone },
            {
                $set: {
                    phone,
                    state,
                    updatedAt: now
                },
                $setOnInsert: {
                    createdAt: now
                }
            },
            { upsert: true }
        );
        console.log(`💾 Заказы пользователя ${phone} сохранено`);
    } catch (error) {
        console.error(`❌ Ошибка сохранения состояния пользователя ${phone}:`, error);
    }
}

// Удаление состояния пользователя
async function deleteUserOrders(phone) {
    try {
        await userDataForOrderCollection.deleteOne({ phone });
        console.log(`🗑️ Заказы пользователя ${phone} удалено`);
    } catch (error) {
        console.error(`❌ Ошибка удаления заказов пользователя ${phone}:`, error);
    }
}

async function deleteUserState(phone) {
    try {
        await userStatesCollection.deleteOne({ phone });
        console.log(`🗑️ Состояние пользователя ${phone} удалено`);
    } catch (error) {
        console.error(`❌ Ошибка удаления состояния пользователя ${phone}:`, error);
    }
}

// Получение состояния ожидания пользователя
async function getUserWaitingState(phone) {
    try {
        const userDoc = await userStatesCollection.findOne({ phone });
        return userDoc?.waitingState || WAITING_STATES.NONE;
    } catch (error) {
        console.error(`❌ Ошибка получения состояния ожидания пользователя ${phone}:`, error);
        return WAITING_STATES.NONE;
    }
}

// Установка состояния ожидания пользователя
async function setUserWaitingState(phone, waitingState, lan) {
    try {
        const now = new Date();
        console.log(`🔄 Устанавливаем состояние ожидания для ${phone}: ${waitingState}`);
        if(waitingState === WAITING_STATES.FLOW_RESPONSE){
            await userStatesCollection.updateOne(
            { phone },
            {
                $set: {
                    phone,
                    waitingState,
                    lan,
                    updatedAt: now
                },
                $setOnInsert: {
                    createdAt: now
                }
            },
            { upsert: true }
        );
        }else{
            await userStatesCollection.updateOne(
            { phone },
            {
                $set: {
                    phone,
                    waitingState,
                    updatedAt: now
                },
                $setOnInsert: {
                    createdAt: now
                }
            },
            { upsert: true }
        );   
        }
    } catch (error) {
        console.error(`❌ Ошибка установки состояния ожидания пользователя ${phone}:`, error);
    }
}

// Очистка состояния ожидания пользователя
async function clearUserWaitingState(phone) {
    try {
        console.log(`✅ Очищаем состояние ожидания для ${phone}`);
        
        await userStatesCollection.updateOne(
            { phone },
            {
                $unset: { waitingState: "" },
                $set: { updatedAt: new Date() }
            }
        );
    } catch (error) {
        console.error(`❌ Ошибка очистки состояния ожидания пользователя ${phone}:`, error);
    }
}

// Получение статистики состояний
async function getUserStatesStats() {
    try {
        const totalUsers = await userStatesCollection.countDocuments();
        const waitingStates = await userStatesCollection.aggregate([
            {
                $group: {
                    _id: "$waitingState",
                    count: { $sum: 1 }
                }
            }
        ]).toArray();
        
        return {
            totalUsers,
            waitingStates: waitingStates.reduce((acc, item) => {
                acc[item._id || 'none'] = item.count;
                return acc;
            }, {})
        };
    } catch (error) {
        console.error("❌ Ошибка получения статистики:", error);
        return { totalUsers: 0, waitingStates: {} };
    }
}

async function startServer() {
    try {
        // Инициализируем MongoDB
        await initMongoDB();

        // // Тестируем GPT-4o
        // const gptWorking = await testGPT4oConnection();
        // if (!gptWorking) {
        //     console.log("⚠️ GPT-4o недоступен, будет использоваться fallback анализ");
        // }

        await getAllProductsForSections();
        
        app.listen(PORT, () => {
            console.log("webhook is listening");
            console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
            console.log(`🤖 AI модель: GPT-4o ${gptWorking ? '✅' : '❌'}`);
        });
    } catch (error) {
        console.error("❌ Ошибка запуска сервера:", error);
        process.exit(1);
    }
}
// Запускаем сервер
startServer();

// Верификация webhook
app.get("/webhook", (req, res) => {
    let mode = req.query["hub.mode"];
    let challenge = req.query["hub.challenge"];
    let token = req.query["hub.verify_token"];

    if (mode && token) {
        if (mode === "subscribe" && token === mytoken) {
            res.status(200).send(challenge);
        } else {
            res.status(403).send("Forbidden");
        }
    }
});

app.post("/webhook", async (req, res) => {
    let body_param = req.body;

    console.log("=== ПОЛУЧЕННОЕ СООБЩЕНИЕ ===");
    console.log(JSON.stringify(body_param, null, 2));

    if (body_param.object) {
        console.log("inside body param");
        if (body_param.entry && 
            body_param.entry[0].changes && 
            body_param.entry[0].changes[0].value.messages && 
            body_param.entry[0].changes[0].value.messages[0]) {
            
            let phone_no_id = body_param.entry[0].changes[0].value.metadata.phone_number_id;
            let from = body_param.entry[0].changes[0].value.messages[0].from;
            let message = body_param.entry[0].changes[0].value.messages[0];

            console.log("phone number " + phone_no_id);
            console.log("from " + from);
            console.log("message type:", message.type);
            console.log("message:", JSON.stringify(message, null, 2));

            // Проверяем текущее состояние ожидания пользователя из MongoDB
            const currentWaitingState = await getUserWaitingState(from);
            console.log(`👤 Текущее состояние ожидания для ${from}: ${currentWaitingState}`);

            try {
                // Проверяем тип сообщения и состояние ожидания
                if (message.type === "location" && currentWaitingState === WAITING_STATES.LOCATION) {
                    // if (currentWaitingState === WAITING_STATES.LOCATION) {
                    //     // Пользователь отправил местоположение когда мы его ждали
                    //     console.log("📍 Обрабатываем ожидаемое местоположение");
                    //     await handleLocationMessage(phone_no_id, from, message);
                    // } else {
                    //     await sendMessage(phone_no_id, from, "Отправьте местоположение.");
                    //     // Местоположение пришло неожиданно - игнорируем
                    //     console.log("📍 Игнорируем неожиданное местоположение");
                    // }
                    console.log("📍 Обрабатываем ожидаемое местоположение");
                    await handleLocationMessage(phone_no_id, from, message);
                } else if (message.type === "interactive"  && currentWaitingState === WAITING_STATES.FLOW_RESPONSE) {
                    console.log("Interactive message type:", message.interactive.type);
                        // Ответ от Flow когда мы его ждали
                        console.log("🔄 Обрабатываем ожидаемый ответ от Flow");
                        await handleFlowResponse(phone_no_id, from, message, body_param);
                    
                } else if (message.type === "order"  && currentWaitingState === WAITING_STATES.CATALOG_ORDER) {
                    // Ответ от каталога в формате order когда мы его ждали
                    console.log("🛒 Обрабатываем ожидаемый ответ от каталога (order)");
                    await handleCatalogOrderResponse(phone_no_id, from, message);
                } 
                else if (message.type === "text" && currentWaitingState === WAITING_STATES.NONE){
    // Любое другое сообщение
    console.log("📝 Обрабатываем обычное сообщение с анализом намерения");
    await handleIncomingMessage(phone_no_id, from, message); // Убираем третий параметр
}else if (message.type === "interactive" && 
   message.interactive.type === "button_reply" && 
   currentWaitingState === WAITING_STATES.LANG){
    // Обработка кнопки выбора языка
    console.log("📝 Обрабатываем сообщение от кнопки выбора языка");
    await handleOrderConfirmationButton(phone_no_id, from, message);
}else{

                }
            } catch (error) {
                console.error("Ошибка обработки сообщения:", error);
            }

            res.sendStatus(200);
        } else {
            res.sendStatus(404);
        }
    }
});


async function handlePaymentConfirmation(phone_no_id, from, message) {
    try {
        console.log("💳 Получено подтверждение оплаты");
        
        const userOrders = await getUserOrders(from);
        if (!userOrders) {
            console.log("❌ Нет ожидающего оплаты заказа");
            await sendMessage(phone_no_id, from, "Не найден заказ, ожидающий оплаты. Попробуйте оформить заказ заново.");
            await clearUserWaitingState(from);
            return;
        }
        
        await sendMessage(phone_no_id, from, "✅ Спасибо! Оформляем ваш заказ...");
        
        // Оформляем заказ с сохраненными данными
        // await submitOrder(
        //     phone_no_id, 
        //     from, 
        //     userOrders.orderItems, 
        //     userOrders.customerData, 
        //     userOrders.locationId, 
        //     userOrders.locationTitle, 
        //     userOrders.orderType, 
        //     userOrders.finalAmount
        // );
        
        
        
    } catch (error) {
        console.error("❌ Ошибка обработки подтверждения оплаты:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при оформлении заказа. Наш менеджер свяжется с вами.");
        await clearUserWaitingState(from);
    }
}

async function handleOrderConfirmationButton(phone_no_id, from, message) {
    try {
        const buttonId = message.interactive.button_reply.id;
        console.log("🔘 Нажата кнопка выбора языка:", buttonId);
        
        // Передаем язык как параметр в handleIncomingMessage
        await handleIncomingMessage(phone_no_id, from, message, buttonId);
        
    } catch (error) {
        console.error("❌ Ошибка обработки кнопки выбора языка:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка. Попробуйте еще раз.");
    }
}

// Обработка местоположения
async function handleLocationMessage(phone_no_id, from, message) {
    try {
        console.log("=== ОБРАБОТКА МЕСТОПОЛОЖЕНИЯ ===");
        
        const location = message.location;
        const longitude = location.longitude;
        const latitude = location.latitude;
        
        console.log(`📍 Получено местоположение: ${latitude}, ${longitude}`);
        
        // Получаем состояние пользователя из MongoDB
        const userState = await getUserState(from);
        
        if (!userState) {
            console.log("❌ Состояние пользователя не найдено");
            await sendMessage(phone_no_id, from, "Произошла ошибка. Попробуйте заново оформить заказ.");
            await clearUserWaitingState(from);
            return;
        }
        
        console.log("👤 Состояние пользователя:", userState);
        
        // Обновляем клиента с новым адресом
        await updateCustomerWithLocation(phone_no_id, from, userState, longitude, latitude);
        
    } catch (error) {
        console.error("❌ Ошибка обработки местоположения:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при сохранении адреса. Попробуйте еще раз.");
        await clearUserWaitingState(from);
    }
}

// Обновление клиента с местоположением
async function updateCustomerWithLocation(phone_no_id, from, userState, longitude, latitude) {
    const lan = await getUserLan(from);
    try {
        console.log("=== ОБНОВЛЕНИЕ КЛИЕНТА С МЕСТОПОЛОЖЕНИЕМ ===");
        
        // Получаем qr_token
        const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
        const qr_token = customerResponse.data.qr_access_token;
        
        console.log("🔑 QR Token:", qr_token);
        
        // Формируем данные для обновления
        const updateData = {
            firstName: userState.customer_name,
            addresses: [{
                fullAddress: userState.delivery_address,
                office: "",
                floor: "",
                doorcode: "",
                entrance: "",
                comment: "",
                geocoding: {
                    datasource: "yandex",
                    longitude: longitude,
                    latitude: latitude,
                    country: "Кыргызстан",
                    countrycode: "KG",
                    city: "Бишкек",
                    street: "",
                    house: "",
                    date: ""
                }
            }]
        };
        
        console.log("📝 Данные для обновления:", updateData);
        
        // Отправляем запрос на обновление
        const updateResponse = await axios.post(
            `${TEMIR_API_BASE}/qr/update-customer/?qr_token=${qr_token}`,
            updateData
        );
        
        console.log("✅ Клиент успешно обновлен:", updateResponse.data);
        
        // ОБНОВЛЯЕМ состояние в MongoDB вместо очистки - добавляем информацию о том, что местоположение обработано
        const updatedState = {
            ...userState,
            order_type: 'delivery', // Принудительно устанавливаем delivery
            delivery_choice: 'new', // Новый адрес
            location_processed: true, // Флаг что местоположение обработано
            new_address: userState.delivery_address, // Сохраняем адрес
            preparation_time: userState.preparation_time,
            specific_time: userState.specific_time,
            promo_code: userState.promo_code,
            comment: userState.comment,
            payment_method: userState.payment_method
        };
        
        await setUserState(from, updatedState);
        
        // Отправляем подтверждение
        if (userState.flow_type === 'new_customer') {
            var confirmText = `Спасибо за регистрацию, ${userState.customer_name}! 🎉\n\nВаш адрес сохранен: ${userState.delivery_address}\n\nТеперь вы можете делать заказы. Сейчас отправлю вам наш каталог! 🍣`;
            if(lan === 'kg'){
                confirmText = `Катталганыңыз үчүн рахмат, ${userState.customer_name}! 🎉\n\nДарегиңиз сакталды: ${userState.delivery_address}\n\nЭми буйрутмаларды бере аласыз. Мен сизге азыр биздин каталогду жөнөтөм! 🍣`;
            }
            
            await sendMessage(phone_no_id, from, confirmText);
        } else {
            var confirmText = `✅ Новый адрес добавлен!\n\n📍 ${userState.delivery_address}\n\nТеперь выберите блюда из каталога:`;
            if(lan === 'kg'){
                confirmText = `✅ Жаңы дарек кошулду!\n\n📍 ${userState.delivery_address}\n\nЭми каталогдон тамактарды тандаңыз:`;
            }
            await sendMessage(phone_no_id, from, confirmText);
        }
        
        // Меняем состояние ожидания на ожидание заказа из каталога
        await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);

        console.log(`after location userState is setUserWaitingState ${from} : ${WAITING_STATES.CATALOG_ORDER}`)
        
        await sendCatalog(phone_no_id, from);
        
    } catch (error) {
        console.error("❌ Ошибка обновления клиента:", error);
        
        let errorMessage = "Произошла ошибка при сохранении данных.";
        if (error.response?.status === 400) {
            errorMessage = "Некорректные данные. Попробуйте еще раз.";
        } else if (error.response?.status === 404) {
            errorMessage = "Клиент не найден. Попробуйте зарегистрироваться заново.";
        }
        
        await sendMessage(phone_no_id, from, errorMessage);
        // Очищаем состояние только при ошибке
        await deleteUserState(from);
        await clearUserWaitingState(from);
    }
}

// Обработка входящих сообщений - проверка клиента
async function handleIncomingMessage(phone_no_id, from, message, buttonLang = null) {
    console.log("=== АНАЛИЗ НАМЕРЕНИЯ КЛИЕНТА ===");
    
    const messageText = message.text?.body;
    
    if (!messageText) {
        console.log("❌ Нет текста сообщения");
        // return;
    }

    console.log(`Получено сообщение от ${from}: ${messageText}`);
    
    // Если это ответ от кнопки выбора языка, используем переданный язык
    if (buttonLang) {
        console.log(`🔘 Обработка кнопки языка: ${buttonLang}`);
        await checkCustomerAndSendFlow(phone_no_id, from, buttonLang);
        return;
    }
    
    try {
        // Анализируем намерение клиента с помощью AI
        const intentAnalysis = await analyzeCustomerIntent(messageText);
        
        console.log("🎯 Результат анализа намерения:", intentAnalysis);
        
        // Обрабатываем в зависимости от намерения
        switch (intentAnalysis.intent) {
            case 'ORDER_INTENT':
                console.log("✅ Клиент хочет заказать - отправляем выбор языка");
                await sendOrderConfirmationButtons(phone_no_id, from);
                break;
                
            case 'ORDER_STATUS':
                console.log("📋 Вопрос о статусе заказа");
                await sendOrderStatusResponse(phone_no_id, from, intentAnalysis.language);
                break;
                
            case 'ORDER_TRACKING':
                console.log("📱 Вопрос об отслеживании заказа");
                await sendOrderTrackingResponse(phone_no_id, from, intentAnalysis.language);
                break;
                
            case 'PICKUP_ADDRESS':
                console.log("📍 Запрос адресов самовывоза");
                await sendPickupAddressResponse(phone_no_id, from, intentAnalysis.language);
                break;
                
            case 'MENU_QUESTION':
                console.log("🍽️ Вопрос о меню");
                await sendMenuResponse(phone_no_id, from, intentAnalysis.language);
                break;
                
            case 'ORDER_FOR_ANOTHER':
                console.log("👥 Вопрос о заказе на другого человека");
                await sendOrderForAnotherResponse(phone_no_id, from, intentAnalysis.language);
                break;
                
            case 'PAYMENT_METHOD':
                console.log("💳 Вопрос о способах оплаты");
                await sendPaymentMethodResponse(phone_no_id, from, intentAnalysis.language);
                break;
                
            case 'OTHER_INTENT':
            default:
                console.log("❓ Другие вопросы - направляем к менеджеру");
                await sendManagerContactMessage(phone_no_id, from, intentAnalysis.language);
                break;
        }
        
    } catch (error) {
        console.error("❌ Ошибка анализа намерения:", error);
        
        // В случае ошибки AI - отправляем выбор языка (безопасный fallback)
        console.log("🔄 Fallback - отправляем выбор языка");
        await sendOrderConfirmationButtons(phone_no_id, from);
    }
}

async function sendOrderStatusResponse(phone_no_id, from, language) {
    let message;
    
    if (language === 'kg') {
        message = `📋 Буйрутмаңыздын статусу жөнүндө:\n\nСиздин WhatsApp'ка буйрутмаңыздын статусу жөнүндө билдирүү жөнөтүлөт.`;
    } else {
        message = `📋 О статусе заказа:\n\nВам будет отправлено уведомление на ваш WhatsApp о статусе заказа.`;
    }
    
    await sendMessage(phone_no_id, from, message);
}

async function sendOrderTrackingResponse(phone_no_id, from, language) {
    let message;
    
    if (language === 'kg') {
        message = `📱 Буйрутманы көзөмөлдөө:\n\nСиздин WhatsApp'ка буйрутмаңыздын статусу жөнүндө билдирүү жөнөтүлөт.`;
    } else {
        message = `📱 Отслеживание заказа:\n\nВам будет отправлено уведомление на ваш WhatsApp о статусе заказа.`;
    }
    
    await sendMessage(phone_no_id, from, message);
}

// 3. Ответ с адресами самовывоза
async function sendPickupAddressResponse(phone_no_id, from, language) {
    let message;
    
    if (language === 'kg') {
        message = `📍 Алып кетүү дареги:\n\n🏪 **Yaposhkin Rolls**\nИсы Ахунбаева 125в\nБишкек, көчөсү Исы Ахунбаева, 125А\n📞 +996709063676\n🕐 Күн сайын 11:00 - 23:45\n\n🏪 **Yaposhkin Rolls Кок жар**\nБишкек, көчөсү Чар, 83\n📞 +996705063676\n🕐 Күн сайын 11:00 - 23:45`;
    } else {
        message = `📍 Адреса для самовывоза:\n\n🏪 **Yaposhkin Rolls**\nИсы Ахунбаева 125в\nБишкек, улица Исы Ахунбаева, 125А\n📞 +996709063676\n🕐 Ежедневно 11:00 - 23:45\n\n🏪 **Yaposhkin Rolls Кок жар**\nБишкек, улица Чар, 83\n📞 +996705063676\n🕐 Ежедневно 11:00 - 23:45`;
    }
    
    await sendMessage(phone_no_id, from, message);
}

// 4. Ответ с меню (PDF файл)
// 4. Ответ с меню (исправленная версия для AWS Lambda)
async function sendMenuResponse(phone_no_id, from, language) {
    try {
        // Сначала отправляем текстовое сообщение
        let textMessage;
        
        if (language === 'kg') {
            textMessage = `🍽️ Биздин толук меню:`;
        } else {
            textMessage = `🍽️ Наше полное меню:`;
        }
        
        await sendMessage(phone_no_id, from, textMessage);
        
        // Определяем путь к файлу в зависимости от среды
        const possiblePaths = [
            './assets/menu.pdf',           // Локальная разработка
            '/var/task/assets/menu.pdf',   // AWS Lambda
            path.join(__dirname, 'assets', 'menu.pdf'), // Универсальный путь
            path.join(process.cwd(), 'assets', 'menu.pdf') // Рабочая директория
        ];
        
        let menuPdfPath = null;
        
        // Ищем файл по всем возможным путям
        for (const filePath of possiblePaths) {
            if (fs.existsSync(filePath)) {
                menuPdfPath = filePath;
                console.log(`✅ PDF файл найден по пути: ${filePath}`);
                break;
            } else {
                console.log(`❌ Файл не найден по пути: ${filePath}`);
            }
        }
        
        // Если файл не найден, выводим отладочную информацию
        if (!menuPdfPath) {
            console.log("🔍 Отладочная информация:");
            console.log("__dirname:", __dirname);
            console.log("process.cwd():", process.cwd());
            console.log("Содержимое текущей директории:", fs.readdirSync(process.cwd()));
            
            // Проверяем есть ли папка assets
            const assetsPath = path.join(process.cwd(), 'assets');
            if (fs.existsSync(assetsPath)) {
                console.log("Содержимое папки assets:", fs.readdirSync(assetsPath));
            } else {
                console.log("Папка assets не найдена");
            }
            
            throw new Error('PDF файл меню не найден ни по одному из путей');
        }
        
        // Читаем файл
        const pdfBuffer = fs.readFileSync(menuPdfPath);
        console.log(`📄 PDF файл прочитан, размер: ${pdfBuffer.length} байт`);
        
        // Отправляем через Media API
        await sendLocalPdfDocument(phone_no_id, from, menuPdfPath, {
            document: {
                filename: language === 'kg' ? "Yaposhkin_Rolls_Menu_KG.pdf" : "Yaposhkin_Rolls_Menu_RU.pdf",
                caption: language === 'kg' ? "📋 Yaposhkin Rolls меню" : "📋 Меню Yaposhkin Rolls"
            }
        });
        
    } catch (error) {
        console.error("❌ Ошибка отправки локального меню:", error);
        
        // Fallback - отправляем текстовое сообщение с информацией
        let fallbackMessage;
        if (language === 'kg') {
            fallbackMessage = `🍽️ Биздин менюда бар:\n\n🍣 Роллдор жана суши\n🍱 Сеттер\n🥗 Салаттар\n🍜 Ысык тамактар\n🥤 Суусундуктар\n\nТолук маалымат үчүн биздин менеджер менен байланышыңыз:\n📞 +996709063676`;
        } else {
            fallbackMessage = `🍽️ В нашем меню есть:\n\n🍣 Роллы и суши\n🍱 Сеты\n🥗 Салаты\n🍜 Горячие блюда\n🥤 Напитки\n\nПолную информацию уточните у нашего менеджера:\n📞 +996709063676`;
        }
        
        await sendMessage(phone_no_id, from, fallbackMessage);
    }
}

// Функция для отправки локального PDF документа (обновленная)
async function sendLocalPdfDocument(phone_no_id, from, filePath, documentMessage) {
    try {
        console.log("📤 Загружаем локальный PDF в WhatsApp Media API");
        
        // Проверяем размер файла
        const stats = fs.statSync(filePath);
        const fileSizeInMB = stats.size / (1024 * 1024);
        console.log(`📊 Размер файла: ${fileSizeInMB.toFixed(2)} MB`);
        
        if (fileSizeInMB > 16) {
            throw new Error(`Файл слишком большой: ${fileSizeInMB.toFixed(2)} MB (максимум 16 MB)`);
        }
        
        // Шаг 1: Загружаем файл в WhatsApp Media API
        const FormData = require('form-data');
        const formData = new FormData();
        const fileStream = fs.createReadStream(filePath);
        
        formData.append('file', fileStream, {
            filename: documentMessage.document.filename,
            contentType: 'application/pdf'
        });
        formData.append('type', 'application/pdf');
        formData.append('messaging_product', 'whatsapp');
        
        // Загружаем файл и получаем media_id
        const uploadResponse = await axios.post(
            `https://graph.facebook.com/v23.0/${phone_no_id}/media`,
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
        console.log("✅ Файл загружен, media_id:", mediaId);
        
        // Шаг 2: Отправляем документ используя media_id
        const messageData = {
            messaging_product: "whatsapp",
            to: from,
            type: "document",
            document: {
                id: mediaId,
                filename: documentMessage.document.filename,
                caption: documentMessage.document.caption
            }
        };
        
        await sendWhatsAppMessage(phone_no_id, messageData);
        console.log("✅ PDF документ отправлен успешно");
        
    } catch (error) {
        console.error("❌ Ошибка отправки локального PDF:", error);
        
        // Если не удалось отправить файл, отправляем каталог
        console.log("🔄 Fallback - отправляем каталог товаров");
        await sendMessage(phone_no_id, from, "📱 Посмотрите наше меню в каталоге ниже:");
        await sendCatalog(phone_no_id, from);
    }
}

// Альтернативный способ без Media API - отправляем каталог вместо PDF
async function sendMenuResponseAlternative(phone_no_id, from, language) {
    try {
        // Отправляем текстовое сообщение
        let textMessage;
        
        if (language === 'kg') {
            textMessage = `🍽️ Биздин толук меню:\n\nТөмөндө каталогду көрсөңүз болот:`;
        } else {
            textMessage = `🍽️ Наше полное меню:\n\nВы можете посмотреть каталог ниже:`;
        }
        
        await sendMessage(phone_no_id, from, textMessage);
        
        // Отправляем каталог товаров вместо PDF
        await sendCatalog(phone_no_id, from);
        
    } catch (error) {
        console.error("❌ Ошибка отправки альтернативного меню:", error);
        
        // Fallback
        let fallbackMessage;
        if (language === 'kg') {
            fallbackMessage = `🍽️ Меню жөнүндө маалымат алуу үчүн биздин менеджер менен байланышыңыз:\n📞 +996709063676`;
        } else {
            fallbackMessage = `🍽️ Информацию о меню уточните у нашего менеджера:\n📞 +996709063676`;
        }
        
        await sendMessage(phone_no_id, from, fallbackMessage);
    }
}
// 5. Ответ о заказе на другого человека
async function sendOrderForAnotherResponse(phone_no_id, from, language) {
    let message;
    
    if (language === 'kg') {
        message = `👥 Башка адамга буйрутма берүү:\n\nСиз башка адамга буйрутма бере аласыз, буйрутма берүү учурунда анын атын жана байланыш номерин көрсөтүп. Ошондой эле керектүү жеткирүү дарегин (эгер алып кетүү эмес болсо) жазууну унутпаңыз.`;
    } else {
        message = `👥 Заказ на другого человека:\n\nВы можете оформить заказ на другого человека, указав его имя и контактный номер при оформлении. Также не забудьте вписать нужный адрес доставки (если не самовывоз).`;
    }
    
    await sendMessage(phone_no_id, from, message);
}

// 6. Ответ о способах оплаты
async function sendPaymentMethodResponse(phone_no_id, from, language) {
    let message;
    
    if (language === 'kg') {
        message = `💳 Төлөө жолдору:\n\nОоба, сиз буйрутманы карта менен төлөй аласыз — буйрутма берүү учурунда онлайн, ошондой эле алуу учурунда (эгер жеткирүү терминал менен төлөөнү колдосо).`;
    } else {
        message = `💳 Способы оплаты:\n\nДа, вы можете оплатить заказ картой — как онлайн при оформлении, так и при получении (если доставка поддерживает оплату терминалом).`;
    }
    
    await sendMessage(phone_no_id, from, message);
}

// Обновленная функция отправки сообщения о контакте с менеджером
async function sendManagerContactMessage(phone_no_id, from, language) {
    console.log(`📞 Отправляем контакт менеджера на языке: ${language}`);
    
    let message;
    
    if (language === 'kg') {
        message = `Саламатсызбы! 🙋‍♀️\n\nБул суроолор боюнча биздин кызматкерибиз менен төмөнкү номер аркылуу байланыша аласыз:\n\n📱 +996709063676\n\nБуйрутма берүү үчүн кайра жазсаңыз болот! 🍣`;
    } else {
        message = `Здравствуйте! 🙋‍♀️\n\nПо данным вопросам можете связаться с нашим сотрудником по номеру:\n\n📱 +996709063676\n\nДля оформления заказа можете написать нам снова! 🍣`;
    }
    
    await sendMessage(phone_no_id, from, message);
}

// Проверка клиента и отправка соответствующего Flow
async function checkCustomerAndSendFlow(phone_no_id, from, lan) {
    try {
        console.log(`🔍 Проверяем клиента: ${from}`);
        
        // Получаем список филиалов для передачи в Flow
        const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
        const restaurants = restaurantsResponse.data;
        
        // Формируем филиалы в формате объектов
        const branches = restaurants.map(restaurant => ({
            id: restaurant.external_id.toString(),
            title: `🏪 ${restaurant.title}`
        }));
        
        console.log("🏪 Филиалы для Flow:", branches);
        
        // Проверяем клиента в базе Temir
        const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
        const customerData = customerResponse.data;
        
        console.log('👤 Данные клиента:', customerData);

        // Проверяем есть ли адреса у клиента
        const hasAddresses = customerData.customer.addresses && customerData.customer.addresses.length > 0;
        const isNewCustomer = !hasAddresses || 
                             !customerData.customer.first_name || 
                             customerData.customer.first_name === 'Имя';

        if (isNewCustomer) {
            console.log('🆕 Новый клиент - отправляем регистрационный Flow');
            if(lan == 'kg'){
                await sendNewCustomerFlowKy(phone_no_id, from, branches);    
            }else{
                await sendNewCustomerFlow(phone_no_id, from, branches);
            }
        } else {
            console.log('✅ Существующий клиент - отправляем Flow с адресами');
            if(lan == 'kg'){
            await sendExistingCustomerFlowKy(phone_no_id, from, customerData.customer, branches);    
            }else{
                await sendExistingCustomerFlow(phone_no_id, from, customerData.customer, branches);
            }
        }

        // Устанавливаем состояние ожидания ответа от Flow
        await setUserWaitingState(from, WAITING_STATES.FLOW_RESPONSE, lan);

    } catch (error) {
        console.error('❌ Ошибка проверки клиента:', error);
        
        // В случае ошибки API - получаем филиалы и отправляем регистрационный Flow
        try {
            const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
            const restaurants = restaurantsResponse.data;
            const branches = restaurants.map(restaurant => ({
                id: restaurant.external_id.toString(),
                title: `🏪 ${restaurant.title}`
            }));
            
            console.log('🆕 Ошибка API - отправляем регистрационный Flow');
            await sendNewCustomerFlow(phone_no_id, from, branches);
            await setUserWaitingState(from, WAITING_STATES.FLOW_RESPONSE);
        } catch (fallbackError) {
            console.error('❌ Критическая ошибка получения филиалов:', fallbackError);
            await sendMessage(phone_no_id, from, "Извините, временные технические проблемы. Попробуйте позже.");
        }
    }
}

// Отправка Flow для новых клиентов
async function sendNewCustomerFlow(phone_no_id, from, branches) {
    console.log("=== ОТПРАВКА FLOW ДЛЯ НОВЫХ КЛИЕНТОВ ===");
    
    const flowData = {
        messaging_product: "whatsapp",
        to: from,
        type: "interactive",
        interactive: {
            type: "flow",
            header: {
                type: "text",
                text: "🍣 Yaposhkin Rolls"
            },
            body: {
                text: "Добро пожаловать!"
            },
            footer: {
                text: "Заполните форму регистрации"
            },
            action: {
                name: "flow",
                parameters: {
                    flow_message_version: "3",
                    flow_token: `new_customer_${Date.now()}`,
                    flow_id: NEW_CUSTOMER_FLOW_ID,
                    flow_cta: "Зарегистрироваться",
                    flow_action: "navigate",
                    flow_action_payload: {
                        screen: "WELCOME_NEW",
                        data: {
                            flow_type: "new_customer",
                            branches: branches
                        }
                    }
                }
            }
        }
    };

    await sendWhatsAppMessage(phone_no_id, flowData);
}

async function sendNewCustomerFlowKy(phone_no_id, from, branches) {
    console.log("=== ОТПРАВКА FLOW ДЛЯ НОВЫХ КЛИЕНТОВ ===");
    
    const flowData = {
        messaging_product: "whatsapp",
        to: from,
        type: "interactive",
        interactive: {
            type: "flow",
            header: {
                type: "text",
                text: "🍣 Yaposhkin Rolls"
            },
            body: {
                text: "Кош келиңиз!\n\nДобро пожаловать!"
            },
            footer: {
                text: "Каттоо формасын толтурунуз"
            },
            action: {
                name: "flow",
                parameters: {
                    flow_message_version: "3",
                    flow_token: `new_customer_${Date.now()}`,
                    flow_id: NEW_CUSTOMER_FLOW_ID,
                    flow_cta: "Каттоо",
                    flow_action: "navigate",
                    flow_action_payload: {
                        screen: "WELCOME_NEW",
                        data: {
                            flow_type: "new_customer",
                            branches: branches
                        }
                    }
                }
            }
        }
    };

    await sendWhatsAppMessage(phone_no_id, flowData);
}

// Отправка Flow для существующих клиентов
async function sendExistingCustomerFlow(phone_no_id, from, customer, branches) {
    console.log("=== ОТПРАВКА FLOW ДЛЯ СУЩЕСТВУЮЩИХ КЛИЕНТОВ ===");
    
    // Формируем массив адресов в формате объектов для dropdown
    const addresses = customer.addresses.map((addr) => ({
        id: `address_${addr.id}`,
        title: addr.full_address
    }));
    
    // Добавляем опцию "Новый адрес"
    addresses.push({
        id: "new",
        title: "➕ Новый адрес"
    });
    
    console.log("📍 Адреса клиента:", addresses);
    
    const flowData = {
        messaging_product: "whatsapp",
        to: from,
        type: "interactive",
        interactive: {
            type: "flow",
            header: {
                type: "text",
                text: "🛒 Оформление заказа"
            },
            body: {
                text: `Привет, ${customer.first_name}!`
            },
            footer: {
                text: "Выберите тип доставки и адрес"
            },
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
                        data: {
                            flow_type: "existing_customer",
                            customer_name: customer.first_name,
                            user_addresses: addresses,
                            branches: branches
                        }
                    }
                }
            }
        }
    };

    await sendWhatsAppMessage(phone_no_id, flowData);
}

async function sendExistingCustomerFlowKy(phone_no_id, from, customer, branches) {
    console.log("=== ОТПРАВКА FLOW ДЛЯ СУЩЕСТВУЮЩИХ КЛИЕНТОВ ===");
    
    // Формируем массив адресов в формате объектов для dropdown
    const addresses = customer.addresses.map((addr) => ({
        id: `address_${addr.id}`,
        title: addr.full_address
    }));
    
    // Добавляем опцию "Новый адрес"
    addresses.push({
        id: "new",
        title: "➕ Жаны дарек"
    });
    
    console.log("📍 Адреса клиента:", addresses);
    
    const flowData = {
        messaging_product: "whatsapp",
        to: from,
        type: "interactive",
        interactive: {
            type: "flow",
            header: {
                type: "text",
                text: "🛒 Буйрутма беруу"
            },
            body: {
                text: `Салам, ${customer.first_name}!`
            },
            footer: {
                text: "Форма толтурунуз"
            },
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
                        data: {
                            flow_type: "existing_customer",
                            customer_name: customer.first_name,
                            user_addresses: addresses,
                            branches: branches
                        }
                    }
                }
            }
        }
    };

    await sendWhatsAppMessage(phone_no_id, flowData);
}

// Обработка ответов Flow
async function handleFlowResponse(phone_no_id, from, message, body_param) {
    try {
        console.log("=== ОБРАБОТКА FLOW ОТВЕТА ===");
        const flowResponse = JSON.parse(message.interactive.nfm_reply.response_json);
        const customerProfile = body_param.entry[0].changes[0].value.contacts[0].profile.name;
        
        console.log('Телефон клиента:', from);
        console.log('Имя профиля WhatsApp:', customerProfile);
        console.log('Данные из Flow:', flowResponse);

        // Определяем тип Flow по данным
        if (flowResponse.flow_type === 'new_customer') {
            await handleNewCustomerRegistration(phone_no_id, from, flowResponse);
        } else if (flowResponse.flow_type === 'existing_customer') {
            await handleExistingCustomerOrder(phone_no_id, from, flowResponse);
        } else {
            // Неизвестный тип flow - отправляем каталог
            console.log("❓ Неизвестный тип Flow, отправляем каталог");
            await sendMessage(phone_no_id, from, "Ошибка обработки flow!");
            
            // await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
            
            // await sendCatalog(phone_no_id, from);
        }

    } catch (error) {
        console.error("Ошибка обработки Flow ответа:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при обработке формы. Попробуйте еще раз.");
        await clearUserWaitingState(from);
    }
}

// Обработка регистрации нового клиента
async function handleNewCustomerRegistration(phone_no_id, from, data) {
    try {
        console.log('📝 Регистрируем нового клиента:', data);

        // const lan = await getUserLan(from);

        // Если выбрана доставка и есть новый адрес - запрашиваем местоположение
        if (data.order_type === 'delivery' && data.delivery_address) {
            // Сохраняем состояние для ожидания местоположения в MongoDB
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

            // Устанавливаем состояние ожидания местоположения
            await setUserWaitingState(from, WAITING_STATES.LOCATION);

            // Отправляем запрос местоположения
            await sendLocationRequest(phone_no_id, from, data.customer_name);
        } else {
            // Самовывоз - сразу регистрируем и отправляем каталог
            await registerCustomerWithoutLocation(phone_no_id, from, data);
        }

    } catch (error) {
        console.error('❌ Ошибка регистрации:', error);
        await sendMessage(phone_no_id, from, 'Извините, произошла ошибка при регистрации. Попробуйте позже.');
        await clearUserWaitingState(from);
    }
}

// Регистрация клиента без местоположения (для самовывоза)
async function registerCustomerWithoutLocation(phone_no_id, from, data) {
    try {
        console.log("=== РЕГИСТРАЦИЯ КЛИЕНТА БЕЗ МЕСТОПОЛОЖЕНИЯ ===");
        const lan = await getUserLan(from);
        // Получаем qr_token
        const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
        const qr_token = customerResponse.data.qr_access_token;
        
        // Формируем данные для обновления (только имя)
        const updateData = {
            firstName: data.customer_name
        };
        
        // Отправляем запрос на обновление
        const updateResponse = await axios.post(
            `${TEMIR_API_BASE}/qr/update-customer/?qr_token=${qr_token}`,
            updateData
        );
        
        console.log("✅ Клиент зарегистрирован:", updateResponse.data);
        
        // Отправляем подтверждение
        const confirmText = `Спасибо за регистрацию, ${data.customer_name}! 🎉\n\nВы выбрали самовывоз.\n\nТеперь выберите блюда из нашего каталога! 🍣`;
        if(lan === 'kg'){
            confirmText = `Катталганыңыз үчүн рахмат, ${data.customer_name}! 🎉\n\nСиз алып кетүүнү тандадыңыз.\n\nЭми биздин каталогдон тамактарды тандаңыз! 🍣`;
        }
        await sendMessage(phone_no_id, from, confirmText);
        
        // Устанавливаем состояние ожидания заказа из каталога
        await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
        
        // Отправляем каталог
        await sendCatalog(phone_no_id, from);
        
    } catch (error) {
        console.error("❌ Ошибка регистрации без местоположения:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при регистрации. Попробуйте еще раз.");
        await clearUserWaitingState(from);
    }
}

// Обработка заказа существующего клиента
async function handleExistingCustomerOrder(phone_no_id, from, data) {
    try {
        const lan = await getUserLan(from);
        console.log('🛒 Обрабатываем заказ существующего клиента:', data);
        
        // Сохраняем данные заказа для дальнейшего использования в MongoDB
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
        
        // Проверяем что выбрал клиент
        if (data.order_type === 'delivery' && data.delivery_choice === 'new' && data.new_address) {
            console.log('📍 Клиент выбрал доставку с новым адресом:', data.new_address);
            
            // Обновляем состояние для запроса местоположения, НО СОХРАНЯЕМ ВСЕ ДАННЫЕ
            const updatedUserState = {
                flow_type: 'existing_customer',
                customer_name: data.customer_name || 'Клиент',
                delivery_address: data.new_address,
                // ВАЖНО: сохраняем все данные заказа
                order_type: data.order_type,
                delivery_choice: data.delivery_choice,
                new_address: data.new_address,
                branch: data.branch,
                preparation_time: data.preparation_time,
                specific_time: data.specific_time,
                promo_code: data.promo_code,
                comment: data.comment,
                payment_method: data.payment_method
            };
            
            await setUserState(from, updatedUserState);
            
            // Устанавливаем состояние ожидания местоположения
            await setUserWaitingState(from, WAITING_STATES.LOCATION);
            
            // Отправляем запрос местоположения
            await sendLocationRequest(phone_no_id, from, data.customer_name);
            
        } else {
            console.log('✅ Клиент выбрал существующий адрес или самовывоз - отправляем каталог');
            
            // Формируем сообщение в зависимости от типа заказа
            let confirmText;
            if (data.order_type === 'delivery') {
                if(lan==='kg'){
                    confirmText = `✅ Эң сонун! Заказ тандалган дарекке жеткирилет.\n\n${data.user_addresses.find(adress => adress.id === data.delivery_choice).title}\n\nКаталогдон тамактарды тандаңыз:`;
                }else{
                    confirmText = `✅ Отлично! Заказ будет доставлен по выбранному адресу.\n\n${data.user_addresses.find(adress => adress.id === data.delivery_choice).title}\n\nВыберите блюда из каталога:`;
                }
            } else {
                if(lan==='kg'){
                confirmText = `✅ Абдан жакшы! Сиз алып кетүүнү тандадыңыз.\n\n${data.branches.find(branch => branch.id === data.branch).title}\n\nКаталогдон тамактарды тандаңыз:`;
                }else{
                    confirmText = `✅ Отлично! Вы выбрали самовывоз.\n\n${data.branches.find(branch => branch.id === data.branch).title}\n\nВыберите блюда из каталога:`;
                }
            }
            
            await sendMessage(phone_no_id, from, confirmText);
            
            // Устанавливаем состояние ожидания заказа из каталога
            await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
            
            // Отправляем каталог
            await sendCatalog(phone_no_id, from);
        }
        
    } catch (error) {
        console.error('❌ Ошибка обработки заказа:', error);
        await sendMessage(phone_no_id, from, 'Извините, произошла ошибка. Попробуйте еще раз.');
        await clearUserWaitingState(from);
    }
}

// Отправка запроса местоположения
async function sendLocationRequest(phone_no_id, from, customerName) {
    console.log("=== ЗАПРОС МЕСТОПОЛОЖЕНИЯ ===");

    const lan = await getUserLan(from);
    var locationText = `Спасибо, ${customerName}! 📍\n\nДля точной доставки, пожалуйста, поделитесь своим местоположением.`;
    if(lan==='kg'){
        locationText = `Рахмат, ${customerName}! 📍\n\nТак жеткирүү үчүн жайгашкан жериңизди бөлүшүңүз.`;
    }
    
    await sendMessage(phone_no_id, from, locationText);
}

// Обработка ответа от каталога в формате order
async function handleCatalogOrderResponse(phone_no_id, from, message) {
    const lan = await getUserLan(from);
    try {
        console.log("=== ОТВЕТ ОТ КАТАЛОГА (ORDER FORMAT) ===");
        console.log("Order message:", JSON.stringify(message, null, 2));
        
        const order = message.order;
        
        // Формируем информацию о заказе
        let orderSummary = lan === 'kg' ? "🛒 Сиздин буйрутмаңыз:\n\n" :"🛒 Ваш заказ:\n\n";
        let totalAmount = 0;
        let orderItems = [];
        
        if (order && order.product_items) {
            console.log("=== ДЕТАЛИ ТОВАРОВ ===");
            
            // Обрабатываем товары последовательно
            for (let index = 0; index < order.product_items.length; index++) {
                const item = order.product_items[index];
                console.log(`Товар ${index + 1}:`, JSON.stringify(item, null, 2));
                
                // Получаем информацию о товаре из API
                const productInfo = await getProductInfo(item.product_retailer_id);
                
                const productName = productInfo.title || `Товар ${item.product_retailer_id}`;
                const productId = productInfo.api_id;
                const itemPrice = parseFloat(item.item_price) || 0;
                const itemTotal = itemPrice * item.quantity;
                
                console.log(`Название товара: ${productName}`);
                
                orderSummary += `${index + 1}. ${productName}\n`;
                orderSummary += lan === 'kg' ? `Даанасы: ${item.quantity} ${productInfo.measure_unit || 'шт'}\n` : `Количество: ${item.quantity} ${productInfo.measure_unit || 'шт'}\n`;
                orderSummary += lan === 'kg' ? `Баасы: ${itemPrice} KGS x ${item.quantity} = ${itemTotal} KGS\n\n` : `Цена: ${itemPrice} KGS x ${item.quantity} = ${itemTotal} KGS\n\n`;
                
                totalAmount += itemTotal;
                
                // Сохраняем для заказа
                orderItems.push({
                    id: parseInt(productId),
                    title: productName,
                    quantity: item.quantity,
                    priceWithDiscount: null,
                    dealDiscountId: null,
                    modifierGroups: []
                });
            }
        }
        
        console.log("📦 Товары для заказа:", orderItems);
        orderSummary += lan === 'kg' ? `💰 Жалпы наркы: ${totalAmount} KGS\n\n` : `💰 Общая стоимость: ${totalAmount} KGS\n\n`;
        
        // Получаем состояние пользователя для определения типа заказа из MongoDB
        const userState = await getUserState(from);
        
        // Рассчитываем доставку и оформляем заказ
        await calculateDeliveryAndSubmitOrder(phone_no_id, from, orderItems, totalAmount, orderSummary, userState);
        
    } catch (error) {
        console.error("Ошибка обработки order ответа каталога:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при обработке заказа. Попробуйте еще раз.");
        await clearUserWaitingState(from);
    }
}

// Расчет доставки и оформление заказа
async function calculateDeliveryAndSubmitOrder(phone_no_id, from, orderItems, totalAmount, orderSummary, userState) {
    const lan = await getUserLan(from);
    try {
        console.log("=== РАСЧЕТ ДОСТАВКИ И ОФОРМЛЕНИЕ ЗАКАЗА ===");
        console.log("User state from parameter:", userState);
        
        // Если userState пустой, пытаемся получить из MongoDB
        if (!userState) {
            console.log("⚠️ User state is null, trying to get from MongoDB");
            userState = await getUserState(from);
            console.log("User state from MongoDB:", userState);
        }
        
        // Если все еще нет состояния, создаем базовое для самовывоза
        if (!userState) {
            console.log("⚠️ No user state found, defaulting to pickup");
            userState = {
                order_type: 'pickup',
                flow_type: 'fallback'
            };
        }
        
        // Получаем данные клиента
        const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
        const customerData = customerResponse.data;
        
        let deliveryCost = 0;
        let locationId = null;
        let locationTitle = "";
        let orderType = userState.order_type || "pickup"; // Используем из состояния или по умолчанию самовывоз
        let deliveryAddress = "";
        let utensils_count = userState.utensils_count

        console.log(`📋 Order type from state: ${orderType}`);
        console.log(`📋 Full userState:`, userState);
        
        // Определяем тип заказа и рассчитываем доставку
        if (orderType === 'delivery') {
            console.log("🚚 Обрабатываем доставку");
            
            let address = null;
            let tempLat = null;
            let tempLon = null;
            
            // Определяем адрес
            if (userState.delivery_choice === 'new' || userState.location_processed) {
                // Новый адрес - ищем в последних добавленных
                const addresses = customerData.customer.addresses || [];
                address = addresses[addresses.length - 1]; // Последний добавленный
                deliveryAddress = userState.new_address || userState.delivery_address || address?.full_address || "";
                console.log(`📍 Using new address: ${deliveryAddress}`);
                console.log(`📍 Address object:`, address);
                
                if (address?.geocoding_json) {
                    console.log(`📍 Address latitude: ${address.geocoding_json.latitude}`);
                    tempLat = address.geocoding_json.latitude;
                    console.log(`📍 Address longitude: ${address.geocoding_json.longitude}`);
                    tempLon = address.geocoding_json.longitude;
                }
            } else {
                // Существующий адрес
                const addressIndex = parseInt(userState.delivery_choice.replace('address_', ''));
                address = customerData.customer.addresses.find(item => item.id == addressIndex);
                deliveryAddress = address?.full_address || "";
                console.log(`📍 Using existing address index ${addressIndex}: ${deliveryAddress}`);
                console.log(`📍 Address object:`, address);
                
                if (address?.geocoding_json) {
                    console.log(`📍 Address latitude: ${address.geocoding_json.latitude}`);
                    tempLat = address.geocoding_json.latitude;
                    console.log(`📍 Address longitude: ${address.geocoding_json.longitude}`);
                    tempLon = address.geocoding_json.longitude;
                }
            }
            
            // Проверяем наличие координат
            if (!tempLat || !tempLon) {
                console.log("❌ Нет координат адреса для доставки");
                await sendMessage(phone_no_id, from, "❌ Ошибка: не удается определить координаты адреса доставки. Попробуйте указать адрес заново или обратитесь к менеджеру.");
                await deleteUserState(from);
                await clearUserWaitingState(from);
                return;
            }
            
            // Если есть координаты - рассчитываем доставку
            const lat = tempLat;
            const lon = tempLon;
            
            console.log(`📍 Координаты доставки: ${lat}, ${lon}`);
            
            try {
                const deliveryResponse = await axios.get(
                    `${TEMIR_API_BASE}/qr/delivery/?lat=${lat}&lon=${lon}`
                );
                
                console.log("🚚 Ответ delivery API:", deliveryResponse.data);
                
                if (deliveryResponse.data[0]) {
                    deliveryCost = deliveryResponse.data[0].delivery_cost || 0;
                    locationId = deliveryResponse.data[0].restaurant_id;
                    locationTitle = deliveryResponse.data[0].title || "Ресторан";
                } else {
                    // Доставка недоступна - отправляем ошибку вместо переключения
                    console.log("❌ Доставка недоступна по указанному адресу");
                    await sendMessage(phone_no_id, from, "❌ К сожалению, доставка по этому адресу недоступна. Попробуйте указать другой адрес или обратитесь к менеджеру.");
                    await deleteUserState(from);
                    await clearUserWaitingState(from);
                    return; 
                }
            } catch (deliveryError) {
                console.error("❌ Ошибка запроса доставки:", deliveryError);
                await sendMessage(phone_no_id, from, "❌ Произошла ошибка при расчете стоимости доставки. Попробуйте позже или обратитесь к менеджеру.");
                await deleteUserState(from);
                await clearUserWaitingState(from);
                return;
            }
        } else {
            // Если самовывоз - выбираем филиал
            console.log("🏪 Обрабатываем самовывоз");
            
            if (userState?.branch) {
                // Филиал выбран в Flow
                const branchInfo = await getBranchInfo(userState.branch);
                if (branchInfo) {
                    locationId = parseInt(userState.branch);
                    locationTitle = branchInfo.title;
                } else {
                    console.log("❌ Информация о выбранном филиале не найдена");
                    await sendMessage(phone_no_id, from, `❌ Ошибка: выбранный филиал недоступен. Попробуйте заново или обратитесь к менеджеру ${contact_branch['1']}.`);
                    await deleteUserState(from);
                    await clearUserWaitingState(from);
                    return;
                }
            } else {
                // Выбираем первый доступный филиал
                try {
                    const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
                    const restaurants = restaurantsResponse.data;
                    
                    if (restaurants.length > 0) {
                        const selectedBranch = restaurants[0];
                        locationId = selectedBranch.external_id;
                        locationTitle = selectedBranch.title;
                    } else {
                        console.log("❌ Нет доступных филиалов");
                        await sendMessage(phone_no_id, from, `❌ Извините, в данный момент нет доступных филиалов для самовывоза. Обратитесь к менеджеру ${contact_branch['1']}.`);
                        await deleteUserState(from);
                        await clearUserWaitingState(from);
                        return;
                    }
                } catch (error) {
                    console.error("❌ Ошибка получения списка филиалов:", error);
                    await sendMessage(phone_no_id, from, "❌ Ошибка получения информации о филиалах. Попробуйте позже или обратитесь к менеджеру.");
                    await deleteUserState(from);
                    await clearUserWaitingState(from);
                    return;
                }
            }
        }
        
        // Проверяем что у нас есть locationId
        if (!locationId) {
            console.log("❌ Не удалось определить локацию для заказа");
            await sendMessage(phone_no_id, from, "❌ Ошибка определения места выполнения заказа. Обратитесь к менеджеру.");
            await deleteUserState(from);
            await clearUserWaitingState(from);
            return;
        }
        
        const finalAmount = totalAmount + deliveryCost;
        
        // Показываем итоговую стоимость
        let costMessage = orderSummary;
        
        if (orderType === "delivery") {
            costMessage += lan === 'kg' ? `🚚 Жеткирүү баасы: ${deliveryCost} KGS\n`: `🚚 Стоимость доставки: ${deliveryCost} KGS\n`;
            costMessage += lan === 'kg' ? `📍 Жеткирүү дареги: ${deliveryAddress}\n\n`: `📍 Адрес доставки: ${deliveryAddress}\n\n`;
        } else {
            costMessage += lan === 'kg' ? `🏪 Алып кетүү: 0 сом\n` : `🏪 Самовывоз: 0 KGS\n`;
            costMessage += `📍 Филиал: ${locationTitle}\n\n`;
        }

        // Добавляем информацию об оплате
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
    
    // Добавляем промокод если есть
    if (userState.promo_code) {
        costMessage += `🎫 Промокод: ${userState.promo_code}\n`;
    }
    
    // Добавляем комментарий если есть
    if (userState.comment) {
        costMessage += `📝 Комментарий: ${userState.comment}\n`;
    }
        
        costMessage += lan === 'kg' ? `💰 Жалпы наркы: ${finalAmount} сом\n\n` : `💰 Общая стоимость: ${finalAmount} KGS\n\n`;
        if (userState.payment_method === 'transfer') {
        costMessage += lan === 'kg' ? `💳 Төлөө ыкмасы: Которуу, QR кодун жөнөтүү...\n` : `💳 Способ оплаты: Перевод, оправка QR кода...\n`;
    } else {
        costMessage += lan === 'kg' ? `⏳ Буйрутмаңыз иштетилүүдө...` : `⏳ Оформляем ваш заказ...`;
    }
        
        await sendMessage(phone_no_id, from, costMessage);

        if (userState.payment_method === 'transfer') {
            // await setUserWaitingState(from, WAITING_STATES.PAYMENT_CONFIRMATION);
            const userOrders = {
            orderItems : orderItems, 
            customerData : customerData, 
            locationId : locationId, 
            locationTitle : locationTitle, 
            orderType : orderType, 
            finalAmount : finalAmount
            };
            await setUserOrder(from, userOrders);
            await sendPaymentQRCodeImproved(phone_no_id, from, finalAmount)
    } 
    await submitOrder(phone_no_id, from, orderItems, customerData, locationId, locationTitle, orderType, finalAmount, utensils_count);
        
    } catch (error) {
        console.error("❌ Ошибка расчета доставки и оформления заказа:", error);
        await sendMessage(phone_no_id, from, `❌ Произошла критическая ошибка при оформлении заказа. Свяжитесь с нашим менеджером ${contact_branch['1']}.`);
        await deleteUserState(from);
        await deleteUserOrders(from);
        await clearUserWaitingState(from);
    }

}

async function sendOrderConfirmationButtons(phone_no_id, to) {
    try {
        const buttonsMessage = {
            messaging_product: "whatsapp",
            to: to,
            type: "interactive",
            interactive: {
                type: "button",
                header: {
                    type: "text",
                    text: "Кош келиниз!"
                },
                body: {
                    text: "📋 Тилди танданыз.\n\n📋 Выберите язык обслуживания."
                },
                footer: {
                    text: "Yaposhkin Rolls"
                },
                action: {
                    buttons: [
                        {
                            type: "reply",
                            reply: {
                                id: "kg",
                                title: "Кыргыз тил"
                            }
                        },
                        {
                            type: "reply",
                            reply: {
                                id: "ru",
                                title: "Русский"
                            }
                        }
                    ]
                }
            }
        };
        
        await setUserWaitingState(to, WAITING_STATES.LANG);

        await sendWhatsAppMessage(phone_no_id, buttonsMessage);
        
    } catch (error) {
        console.error("❌ Ошибка отправки кнопок подтверждения:", error);
        
        // Fallback - отправляем обычное сообщение
        const fallbackMessage = "\n\nОтправьте любое сообщение для подтверждения заказа или напишите 'отмена' для отмены.";
        await sendMessage(phone_no_id, to, fallbackMessage);
    }
}

async function sendPaymentQRCodeImproved(phone_no_id, to, amount) {
    const lan = await getUserLan(to);
    try {
        console.log("💳 Отправляем QR код для оплаты");
        
        const qrImageUrl = "https://yaposhkinrolls.com/image-proxy-new/460x460,q85,spFLp372BcVbVX3LkpozjsUzn_ZkOP_vM1B6xzIL8Ey4/https://storage.yandexcloud.net/quickrestobase/ve738/offer/681b464f-8e8d-4b5e-b96a-c2628eaf7a52.png";
        const paymentPhone = "+996709063676";
        const paymentRecipient = "ЭМИРЛАН Э.";
        
        const imageMessage = {
            messaging_product: "whatsapp",
            to: to,
            type: "image",
            image: {
                link: qrImageUrl,
                caption: lan==='kg' ? `💳 Төлөө үчүн QR коду\n\n💰 Төлөө турган сумма: ${amount} KGS\n📱 ${paymentPhone}\n👤 ${paymentRecipient}\n` : `💳 QR код для оплаты\n\n💰 Сумма к оплате: ${amount} KGS\n📱 ${paymentPhone}\n👤 ${paymentRecipient}\n`
            }
        };
        
        await sendWhatsAppMessage(phone_no_id, imageMessage);
        
    } catch (error) {
        console.error("❌ Ошибка отправки QR кода:", error);
        
        // Fallback - отправляем текстовое сообщение с реквизитами
        const paymentPhone = "+996709063676";
        const paymentRecipient =  "ЭМИРЛАН Э.";
        
        const fallbackMessage = lan==='kg' ? `💳 Которуу аркылуу төлөө:\n\n📱 ${paymentPhone}\n👤 ${paymentRecipient}\n\n💰 Төлөнө турган сумма: ${amount} KGS\n` : `💳 Оплата переводом:\n\n📱 ${paymentPhone}\n👤 ${paymentRecipient}\n\n💰 Сумма к оплате: ${amount} KGS\n`;
        await sendMessage(phone_no_id, to, fallbackMessage);
    }
}

// Отправка заказа в API
async function submitOrder(phone_no_id, from, orderItems, customerData, locationId, locationTitle, orderType, finalAmount, utensils_count) {
    const lan = await getUserLan(from);
    try {
        console.log("📝 Отправляем заказ в API");
        
        // Формируем данные для preorder
        const preorderData = {
            locationId: parseInt(locationId),
            locationTitle: locationTitle,
            type: orderType,
            customerContact: {
                firstName: "Test",
                comment: (utensils_count && utensils_count !== '0') ? `Test\nКоличество приборов: ${utensils_count}` : `Test`,
                contactMethod: {
                    type: "phoneNumber",
                    value: from
                }
            },
            orderDueDateDelta: 0, // Как можно скорее
            guests: [{
                orderItems: orderItems
            }],
            paymentSumWithDiscount: null
        };
        
        console.log("📝 Данные для preorder:", JSON.stringify(preorderData, null, 2));
        
        // Отправляем заказ в API
        const preorderResponse = await axios.post(
            `${TEMIR_API_BASE}/qr/preorder/?qr_token=${customerData.qr_access_token}`,
            preorderData
        );
        
        console.log("✅ Ответ preorder API:", preorderResponse.data);
        
        // Проверяем наличие ошибки в ответе даже при статусе 200
        if (preorderResponse.data.error) {
            console.log("❌ Обнаружена ошибка в ответе API:", preorderResponse.data.error);
            throw {
                response: {
                    status: 200,
                    data: preorderResponse.data
                }
            };
        }
        
        // Отправляем сообщение об успехе
        await sendOrderSuccessMessage(phone_no_id, from, preorderResponse.data, orderType, finalAmount, locationTitle, locationId);

        

    } catch (error) {
        console.error('❌ Ошибка отправки заказа в API:', error);
        
        let errorMessage = '';
        
        // Проверяем специфичные ошибки
        if (error.response?.data?.error?.description) {
            const errorDescription = error.response.data.error.description;
            
            if (errorDescription.includes("Location is closed")) {
                // Филиал закрыт
                console.log("🔒 Филиал закрыт");
                
                // Получаем информацию о режиме работы
                const workingHours = await getLocationWorkingHours(locationId);
                
                if (orderType === 'delivery') {
    errorMessage = lan === 'ru' ? `⏰ К сожалению, доставка сейчас недоступна.\n\n` : `⏰ Тилекке каршы, учурда жеткирүү мүмкүн эмес.\n\n`;
    errorMessage += lan === 'ru' ? `🏪 Филиал "${locationTitle}" закрыт.\n` : `🏪 "${locationTitle}" филиалы жабык.\n`;
    if (workingHours) {
        errorMessage += lan === 'ru' ? `🕐 Режим работы: ${workingHours}\n\n` : `🕐 Иш убактысы: ${workingHours}\n\n`;
    }
    errorMessage += lan === 'ru' ? `Вы можете оформить заказ в рабочее время.` : `Иш убактысында заказ бере аласыз.`;
} else {
    errorMessage = lan === 'ru' ? `⏰ К сожалению, самовывоз сейчас недоступен.\n\n` : `⏰ Тилекке каршы, учурда өзү алып кетүү мүмкүн эмес.\n\n`;
    errorMessage += lan === 'ru' ? `🏪 Филиал "${locationTitle}" закрыт.\n` : `🏪 "${locationTitle}" филиалы жабык.\n`;
    if (workingHours) {
        errorMessage += lan === 'ru' ? `🕐 Режим работы: ${workingHours}\n\n` : `🕐 Иш убактысы: ${workingHours}\n\n`;
    }
    errorMessage += lan === 'ru' ? `Вы можете забрать заказ в рабочее время.` : `Иш убактысында заказды алып кете аласыз.`;
}
} else if (errorDescription.includes("out of stock") || errorDescription.includes("unavailable")) {
// Товар недоступен
errorMessage = lan === 'ru' ? 
    `❌ К сожалению, некоторые товары из вашего заказа сейчас недоступны.\n\n` :
    `❌ Тилекке каршы, заказыңыздын кээ бир товарлары учурда жок.\n\n`;
errorMessage += lan === 'ru' ? 
    `Попробуйте выбрать другие блюда из каталога или обратитесь к менеджеру по номеру ${contact_branch[locationId]}.` :
    `Каталогдон башка тамактарды тандаңыз же ${contact_branch[locationId]} номери аркылуу менеджерге кайрылыңыз.`;
} else if (errorDescription.includes("SoldOutProductException")) {
const productIds = error.response.data.error.productIds;

const unavailableItems = productIds
    .map(productId => orderItems.find(order => productId === order.id))
    .filter(item => item) // убираем undefined
    .map(item => item.title)
    .join('\n');

errorMessage = lan === 'ru' ? 
    `❌ К сожалению, эти товары из вашего заказа сейчас недоступны.\n\n${unavailableItems}\n\nПопробуйте выбрать другие блюда из каталога или обратитесь к менеджеру по номеру ${contact_branch[locationId]}.` :
    `❌ Тилекке каршы, заказыңыздан бул товарлар учурда жок.\n\n${unavailableItems}\n\nКаталогдон башка тамактарды тандаңыз же ${contact_branch[locationId]} номери аркылуу менеджерге кайрылыңыз.`;
}
else {
// Другие ошибки API
errorMessage = lan === 'ru' ? 
    `❌ Ошибка оформления заказа: ${errorDescription}\n\n` :
    `❌ Заказ берүүдө ката: ${errorDescription}\n\n`;
errorMessage += lan === 'ru' ? 
    `Обратитесь к менеджеру по номеру ${contact_branch[locationId]} для решения проблемы.` :
    `Маселени чечүү үчүн ${contact_branch[locationId]} номери аркылуу менеджерге кайрылыңыз.`;
}
} else if (error.response?.data?.error?.type) {
// Обработка ошибок по типу
const errorType = error.response.data.error.type;

if (errorType === "LocationIsClosedException") {
    console.log("🔒 Филиал закрыт (по типу ошибки)");
    
    const workingHours = await getLocationWorkingHours(locationId);
    
    errorMessage = lan === 'ru' ? 
        `⏰ К сожалению, ${orderType === 'delivery' ? 'доставка' : 'самовывоз'} сейчас недоступен.\n\n` :
        `⏰ Тилекке каршы, учурда ${orderType === 'delivery' ? 'жеткирүү' : 'өзү алып кетүү'} мүмкүн эмес.\n\n`;
    errorMessage += lan === 'ru' ? 
        `🏪 Филиал "${locationTitle}" закрыт.\n` :
        `🏪 "${locationTitle}" филиалы жабык.\n`;
    if (workingHours) {
        errorMessage += lan === 'ru' ? 
            `🕐 Режим работы: ${workingHours}\n\n` :
            `🕐 Иш убактысы: ${workingHours}\n\n`;
    }
    errorMessage += lan === 'ru' ? 
        `Вы можете оформить заказ в рабочее время или обратиться к менеджеру по номеру ${contact_branch[locationId]}.` :
        `Иш убактысында заказ бере аласыз же ${contact_branch[locationId]} номери аркылуу менеджерге кайрыла аласыз.`;
} else {
    errorMessage = lan === 'ru' ? 
        `❌ Ошибка: ${errorType}\n\n` :
        `❌ Ката: ${errorType}\n\n`;
    errorMessage += lan === 'ru' ? 
        `Обратитесь к менеджеру по номеру ${contact_branch[locationId]} для решения проблемы.` :
        `Маселени чечүү үчүн ${contact_branch[locationId]} номери аркылуу менеджерге кайрылыңыз.`;
}
} else if (error.response?.status === 400) {
errorMessage = lan === 'ru' ? 
    `❌ Ошибка в данных заказа.\n\n` :
    `❌ Заказ маалыматтарында ката.\n\n`;
errorMessage += lan === 'ru' ? 
    `Попробуйте оформить заказ заново или обратитесь к менеджеру по номеру ${contact_branch[locationId]}.` :
    `Заказды кайра берип көрүңүз же ${contact_branch[locationId]} номери аркылуу менеджерге кайрылыңыз.`;
} else if (error.response?.status === 404) {
errorMessage = lan === 'ru' ? 
    `❌ Выбранный филиал временно недоступен.\n\n` :
    `❌ Тандалган филиал убактылуу жеткиликсиз.\n\n`;
errorMessage += lan === 'ru' ? 
    `Попробуйте позже или обратитесь к менеджеру по номеру ${contact_branch[locationId]}.` :
    `Кийинчерээк аракет кылыңыз же ${contact_branch[locationId]} номери аркылуу менеджерге кайрылыңыз.`;
} else if (error.response?.status === 500) {
errorMessage = lan === 'ru' ? 
    `❌ Технические неполадки на сервере.\n\n` :
    `❌ Серверде техникалык көйгөйлөр.\n\n`;
errorMessage += lan === 'ru' ? 
    `Мы уже работаем над решением проблемы. Попробуйте через несколько минут или обратитесь к менеджеру по номеру ${contact_branch[locationId]}.` :
    `Биз маселени чечүү боюнча иштеп жатабыз. Бир нече мүнөттөн кийин аракет кылыңыз же ${contact_branch[locationId]} номери аркылуу менеджерге кайрылыңыз.`;
} else {
errorMessage = lan === 'ru' ? 
    `❌ Произошла ошибка при оформлении заказа.\n\n` :
    `❌ Заказ берүүдө ката кетти.\n\n`;
errorMessage += lan === 'ru' ? 
    `Обратитесь к менеджеру по номеру ${contact_branch[locationId]} для уточнения деталей.` :
    `Чоо-жайларды так дайындоо үчүн ${contact_branch[locationId]} номери аркылуу менеджерге кайрылыңыз.`;
}
        

        await sendMessage(phone_no_id, from, errorMessage);
        if(errorMessage.includes("эти товары")){
            await sendCatalog(phone_no_id, from);
            await setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER);
        }else{
            // Очищаем состояние
            await deleteUserState(from);
            await clearUserWaitingState(from);
        }
    }
}

// Получение режима работы филиала
async function getLocationWorkingHours(locationId) {
    try {
        console.log(`🕐 Получаем режим работы для филиала ${locationId}`);
        
        // Получаем информацию о ресторанах
        const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
        const restaurants = restaurantsResponse.data;
        
        // Находим нужный ресторан
        const restaurant = restaurants.find(r => r.external_id == locationId);
        
        if (restaurant && restaurant.schedule) {
            // Получаем текущий день недели
            const today = new Date().getDay(); // 0 = воскресенье, 1 = понедельник, и т.д.
            const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const dayNamesRu = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
            
            const todayKey = dayNames[today];
            const todayNameRu = dayNamesRu[today];
            
            // Ищем расписание на сегодня
            const todaySchedule = restaurant.schedule.find(s => s.day === todayKey);
            
            if (todaySchedule) {
                if (todaySchedule.active) {
                    // Форматируем время
                    const timeStart = todaySchedule.timeStart.substring(0, 5); // "11:00:00" -> "11:00"
                    const timeEnd = todaySchedule.timeEnd.substring(0, 5);     // "23:45:59" -> "23:45"
                    
                    return `${todayNameRu}: ${timeStart} - ${timeEnd}`;
                } else {
                    return `${todayNameRu}: выходной`;
                }
            }
            
            // Если не нашли сегодня, показываем общий режим работы
            const workingDays = restaurant.schedule.filter(s => s.active);
            if (workingDays.length > 0) {
                const firstDay = workingDays[0];
                const timeStart = firstDay.timeStart.substring(0, 5);
                const timeEnd = firstDay.timeEnd.substring(0, 5);
                return `Обычно: ${timeStart} - ${timeEnd}`;
            }
        }
        
        // Режим работы по умолчанию если не найден в API
        return "11:00 - 23:45";
        
    } catch (error) {
        console.error("❌ Ошибка получения режима работы:", error);
        // Возвращаем стандартный режим работы
        return "11:00 - 23:45";
    }
}

// Отправка сообщения об успешном заказе
async function sendOrderSuccessMessage(phone_no_id, from, preorderResponse, orderType, finalAmount, locationTitle, locationId) {
    const lan = await getUserLan(from);
    try {
        let successMessage = '';
        
        if (preorderResponse.status === 'success') {
            successMessage = lan==='kg' ? '🎉 Буйрутмаңыз кабыл алынды!\n\n' : '🎉 Ваш заказ принят!\n\n';
            successMessage += lan==='kg' ? `📋 Буйрутма номери: ${preorderResponse.data.preorder_id}\n\n` : `📋 Номер заказа: ${preorderResponse.data.preorder_id}\n\n`;
            
            if (orderType === 'pickup') {
                successMessage += lan==='kg' ? `🏪 Алуучу филиал:\n` : `🏪 Самовывоз из филиала:\n`;
                successMessage += `📍 ${locationTitle}\n`;
            } else {
                successMessage += lan==='kg' ? `🚗 Дарегиңиз боюнча жеткирүү\n` : `🚗 Доставка по вашему адресу\n`;
            }

            successMessage += lan==='kg' ? `💰 Төлөө турган сумма: ${finalAmount} сом\n\n` : `💰 Сумма к оплате: ${finalAmount} KGS\n\n`;
            successMessage += lan==='kg' ? '⏳ Буйрутмаңыз даяр болгондо билдирүү келет.\n\n' : '⏳ Ожидайте уведомления о статусе заказа.\n\n';
            successMessage += lan==='kg' ? `📞 Суроолоруңуз болсо, биз менен телефон аркылуу байланышсаңыз болот ${contact_branch[locationId]}.` : `📞 Если у вас есть вопросы, вы можете связаться с нами по телефону ${contact_branch[locationId]}.`;

            await setUserWaitingState(from, WAITING_STATES.ORDER_STATUS);
        } else {
            successMessage = lan==='kg' ? '❌ Буйрутмаңызды берүү учурунда ката кетти.\n' : '❌ Произошла ошибка при оформлении заказа.\n';
            successMessage += lan==='kg' ? `Биздин менеджер чоо-жайын тактоо үчүн байланышсаңыз болот ${contact_branch[locationId]}.` : `Для уточнения деталей вы можете связаться с нами по телефону ${contact_branch[locationId]}.`;
            await deleteUserState(from);
            await clearUserWaitingState(from);
        }

        await sendMessage(phone_no_id, from, successMessage);
        
    } catch (error) {
        console.error('❌ Ошибка отправки сообщения об успехе:', error);
        await deleteUserState(from);
        await clearUserWaitingState(from);
    }
}

// Остальные функции...
async function handleButtonResponse(phone_no_id, from, message) {
    try {
        console.log("=== ОТВЕТ ОТ КНОПКИ ===");
        const buttonId = message.interactive.button_reply.id;
        
        // Обрабатываем нажатие кнопок если нужно
        console.log("Button ID:", buttonId);
    } catch (error) {
        console.error("Ошибка обработки ответа кнопки:", error);
    }
}

async function handleCatalogResponse(phone_no_id, from, message) {
    try {
        console.log("=== ОТВЕТ ОТ КАТАЛОГА (PRODUCT LIST) ===");
        console.log("Catalog response:", JSON.stringify(message.interactive, null, 2));
        
        // Этот тип ответа каталога используется редко
        // Основной формат - order в handleCatalogOrderResponse
        await sendMessage(phone_no_id, from, "Спасибо за выбор! Обрабатываем ваш заказ...");
        
        // Завершаем процесс заказа
        await clearUserWaitingState(from);
        
    } catch (error) {
        console.error("Ошибка обработки ответа каталога:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при обработке заказа. Попробуйте еще раз.");
        await clearUserWaitingState(from);
    }
}

// Кэш товаров для оптимизации
let productsCache = null;
let cacheExpiry = null;

let productsCacheForSection = null;
let cacheExpiryFotSection = null;

// Получение всех товаров и кэширование
async function getAllProducts() {
    try {
        // Проверяем кэш (обновляем каждые 30 минут)
        if (productsCache && cacheExpiry && Date.now() < cacheExpiry) {
            console.log("📦 Используем кэшированные товары");
            return productsCache;
        }
        
        console.log("🔄 Загружаем товары из API");
        const response = await axios.get(`${TEMIR_API_BASE}/qr/products`);
        const products = response.data;
        
        // Создаем мапу для быстрого поиска по ID
        const productsMap = {};
        products.forEach(product => {
            productsMap[product.id] = {
                id: product.id,
                api_id: product.api_id,
                title: product.title,
                measure_unit: product.measure_unit_title || 'шт'
            };
        });
        
        // Кэшируем на 30 минут
        productsCache = productsMap;
        cacheExpiry = Date.now() + (30 * 60 * 1000);
        
        console.log(`✅ Загружено ${products.length} товаров`);
        return productsMap;
        
    } catch (error) {
        console.error("❌ Ошибка загрузки товаров:", error.response?.status, error.response?.data);
        return productsCache || {}; // Возвращаем старый кэш если есть
    }
}

async function getAllProductsForSections() {
    try {
        // Проверяем кэш (обновляем каждые 30 минут)
        if (productsCacheForSection) {
            console.log("📦 Используем кэшированные товары");
            return productsCacheForSection;
        }
        
        console.log("🔄 Загружаем товары из API");
        const response = await axios.get(`${TEMIR_API_BASE}/qr/products`);
        const products = response.data;
        
        // Создаем мапу для быстрого поиска по ID
        const productsMap = {};
        products.forEach(product => {
            productsMap[product.api_id] = {
                id: product.id,
                api_id : product.api_id,
                title : product.title
            };
        });
        
        // Кэшируем 
        productsCacheForSection = productsMap;
        
        console.log(`✅ Загружено ${products.length} товаров`);
        return productsMap;
        
    } catch (error) {
        console.error("❌ Ошибка загрузки товаров:", error.response?.status, error.response?.data);
        return productsCacheForSection || {}; // Возвращаем старый кэш если есть
    }
}

// Получение информации о товаре по ID
async function getProductInfo(productId) {
    try {
        const products = await getAllProducts();
        
        if (products[productId]) {
            console.log(`✅ Товар найден в кэше: ${products[productId].title}`);
            return products[productId];
        } else {
            console.log(`❓ Товар ${productId} не найден в кэше, запрашиваем отдельно`);
            
            // Fallback - запрашиваем конкретный товар
            const response = await axios.get(`${TEMIR_API_BASE}/qr/products/${productId}`);
            const product = response.data;
            
            return {
                id: product.id,
                api_id: product.api_id,
                title: product.title,
                measure_unit: product.measure_unit_title || 'шт'
            };
        }
        
    } catch (error) {
        console.error(`❌ Ошибка получения товара ${productId}:`, error.response?.status);
        
        return {
            id: productId,
            title: `Товар ${productId}`,
            measure_unit: 'шт'
        };
    }
}

async function getProductInfoForSections(productId) {
    try {
        const products = await getAllProductsForSections();
        
        if (products[productId]) {
            console.log(`✅ Товар найден в кэше: ${products[productId].title}`);
            return products[productId];
        } else {
            console.log(`❓ Товар ${productId} не найден в кэше, запрашиваем отдельно`);
            
            // Fallback - запрашиваем конкретный товар
            const response = await axios.get(`${TEMIR_API_BASE}/qr/products/${productId}`);
            const product = response.data;
            
            return {
                id: product.id
            };
        }
        
    } catch (error) {
        console.error(`❌ Ошибка получения товара ${productId}:`, error.response?.status);
        
        return {
            id: productId,
            title: `Товар ${productId}`,
            measure_unit: 'шт'
        };
    }
}
// Получение информации о филиалах
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
    } catch (error) {
        console.error('Ошибка получения информации о филиале:', error);
        return null;
    }
}

// Универсальная функция отправки WhatsApp сообщений
async function sendWhatsAppMessage(phone_no_id, messageData) {
    try {
        const response = await axios({
            method: "POST",
            url: `https://graph.facebook.com/v23.0/${phone_no_id}/messages?access_token=${token}`,
            data: messageData,
            headers: {
                "Content-Type": "application/json"
            }
        });
        
        console.log("✅ Сообщение отправлено успешно:", response.data);
        return response.data;
    } catch (error) {
        console.error("❌ Ошибка отправки сообщения:");
        console.error("Status:", error.response?.status);
        console.error("Data:", error.response?.data);
        throw error;
    }
}

async function fetchAndConvertMenuData() {
    try {
        // Получаем данные из API
        const response = await axios.get('https://ya.temir.me/qr/catalog');
        const apiData = response.data;
        
        
        // const optimizedMenuGroups = apiData.map(group => {
        //     return group.map(section => {
        //         section.products.map(id => await getProductInfoForSections(id))
        //         return ({
        //         section_title: section.section_title,
        //         products: section.products
        //     })});
        // });

        const optimizedMenuGroups = await Promise.all(
  apiData.map(async (group) => {
    return await Promise.all(
      group.map(async (section) => {
        const productIds = await Promise.all(
          section.products.map(async (api_id) => {
            const product = await getProductInfoForSections(api_id);
            return product.id; // только id
          })
        );

        return {
            section_title: section.section_title,
          products: productIds
        };
      })
    );
  })
);
        
        return optimizedMenuGroups;
    } catch (error) {
        console.error('Ошибка при получении данных:', error.message);
        return null;
    }
}

// Оптимизированные группы товаров (6 сообщений вместо 12)
// const optimizedMenuGroups = [
//     // Группа 1: Роллы (первые 30)
//     [
//         {
//             section_title: "Роллы",
//             products: [
//                 "71", "46", "54", "58", "63", "62", "60", "61", "49", "48", 
//                 "47", "50", "53", "72", "67", "70", "68", "69", "52", "51", 
//                 "57", "64", "56", "59", "66", "65", "55", "38", "36", "37"
//             ]
//         }
//     ],
    
//     // Группа 2: Роллы (оставшиеся) + Теплые роллы + Роллы без риса + Круассаны + Сладкие роллы (30 товаров)
//     [
//         {
//             section_title: "Роллы (продолжение)",
//             products: ["41", "35", "42", "44", "45", "43", "40", "39", "34"]
//         },
//         {
//             section_title: "теплые",
//             products: ["24", "26", "33", "28", "25", "27", "29", "30", "23", "31", "32"]
//         },
//         {
//             section_title: "без риса",
//             products: ["136", "134", "135"]
//         },
//         {
//             section_title: "сладкие",
//             products: ["150", "139", "137", "138"]
//         }
//     ],
    
//     // Группа 3: Классические роллы + Темпура роллы (15 товаров)
//     [
//         {
//             section_title: "Классические роллы",
//             products: ["131", "130", "127", "133", "129", "128", "132"]
//         },
//         {
//             section_title: "Темпура роллы",
//             products: ["19", "17", "15", "21", "20", "18", "16", "22"]
//         },
//         {
//             section_title: "Круассаны",
//             products: ["93", "94", "92"]
//         }
//     ],
    
//     // Группа 4: Суши и гунканы + Теплые сеты (28 товаров)
//     [
//         {
//             section_title: "Суши и гунканы",
//             products: [
//                 "85", "86", "81", "82", "91", "78", "84", "80", "79", "83", 
//                 "77", "75", "73", "76", "74", "89", "88", "87", "90"
//             ]
//         }
//     ],
    
//     // Группа 5: Сеты (24 товара)
//     [
//         {
//             section_title: "Сеты",
//             products: [
//                 "109", "117", "123", "111", "112", "105", "103", "113", "118", 
//                 "106", "119", "124", "121", "108", "110", "116", "125", "114", 
//                 "104", "107", "122", "126", "120", "115"
//             ]
//         },
//         {
//             section_title: "Теплые сеты",
//             products: ["6", "3", "4", "1", "2", "5"]
//         }
//     ],
    
//     // Группа 6: Салаты + Напитки + Дополнительно (26 товаров)
//     [
//         {
//             section_title: "Салаты",
//             products: ["98", "96", "95", "97", "99", "102", "101", "100"]
//         },
//         {
//             section_title: "Напитки",
//             products: ["13", "9", "8", "10", "12", "14", "7", "11"]
//         },
//         {
//             section_title: "Дополнительно",
//             products: ["142", "141", "144", "140", "143", "147", "148", "149", "146", "145"]
//         }
//     ]
// ];

async function sendCatalog(phone_no_id, to) {
    console.log("=== ОТПРАВКА ОПТИМИЗИРОВАННОГО КАТАЛОГА ===");
    const lan = await getUserLan(to);
    try {
        // Получаем CATALOG_ID из переменных окружения
        const catalogId = process.env.CATALOG_ID;
        if (!catalogId) {
            console.error("❌ CATALOG_ID не найден в переменных окружения");
            throw new Error("CATALOG_ID не настроен");
        }

        
        // Используем оптимизированные группы
        const categoryGroups = await fetchAndConvertMenuData();
        
        console.log(`📊 Оптимизированная группировка:`);
        console.log(`   Исходно: 12 категорий`);
        console.log(`   Результат: ${categoryGroups.length} групп`);
        console.log(`   💰 Экономия: ${12 - categoryGroups.length} сообщений`);
        
        categoryGroups.forEach((group, index) => {
            const totalProducts = group.reduce((sum, cat) => sum + cat.products.length, 0);
            const categoryNames = group.map(cat => cat.section_title).join(', ');
            console.log(`   Группа ${index + 1}: ${group.length} категорий, ${totalProducts} товаров`);
            console.log(`     Категории: ${categoryNames}`);
        });
        
        // Отправляем каждую группу как отдельный product_list
        for (let i = 0; i < categoryGroups.length; i++) {
            const group = categoryGroups[i];
            
            const totalProducts = group.reduce((sum, cat) => sum + cat.products.length, 0);
            console.log(`📤 Отправляем группу ${i + 1}/${categoryGroups.length} (${totalProducts} товаров)`);
            
            await sendProductListWithSections(phone_no_id, to, group, i + 1, categoryGroups.length, catalogId, lan);
        }
        
        // Отправляем финальное сообщение
        var finalText = `Выберите понравившиеся блюда из любой категории и добавьте в корзину.`;
        if(lan === 'kg'){
            finalText = `Каалаган категориядан тамактарды тандаңыз.`;
        }
        await sendMessage(phone_no_id, to, finalText);
        
        console.log("✅ Оптимизированный каталог отправлен полностью");
        
    } catch (error) {
        await sendMessage(phone_no_id, to, "Ошибка отправки каталога");
        console.error("❌ Ошибка отправки каталога:", error);
        
        // Fallback - отправляем обычный каталог
        console.log("🔄 Отправляем обычный каталог как fallback");
        // const fallbackCatalogData = {
        //     messaging_product: "whatsapp",
        //     to: to,
        //     type: "interactive",
        //     interactive: {
        //         type: "catalog_message",
        //         body: {
        //             text: "🍣 Наш полный каталог Yaposhkin Rolls!\n\nВыберите понравившиеся блюда и добавьте в корзину. Все товары свежие и готовятся с любовью! ❤️"
        //         },
        //         footer: {
        //             text: "Доставка 30-40 минут"
        //         },
        //         action: {
        //             name: "catalog_message"
        //         }
        //     }
        // };
        
        // await sendWhatsAppMessage(phone_no_id, fallbackCatalogData);
    }
}

async function sendProductListWithSections(phone_no_id, to, categories, groupNumber, totalGroups, catalogId, lan) {
    try {
        // Формируем секции для WhatsApp
        const sections = categories.map(category => ({
            title: category.section_title,
            product_items: category.products.map(id => ({
                product_retailer_id: id
            }))
        }));
        
        // Подсчитываем общее количество товаров
        const totalProducts = categories.reduce((sum, cat) => sum + cat.products.length, 0);
        
        // Формируем умный заголовок
        let headerText;
        if (categories.length === 1) {
            // Одна категория
            headerText = `🍣 ${categories[0].section_title}`;
        } else if (categories.length === 2) {
            // Две категории
            headerText = `🍣 ${categories[0].section_title} и ${categories[1].section_title}`;
        } else if (categories.length === 3) {
            // Три категории
            headerText = `🍣 ${categories[0].section_title}, ${categories[1].section_title} и ${categories[2].section_title}`;
        } else if (categories.length === 4) {
            // Четыре категории
            headerText = `🍣 ${categories[0].section_title}, ${categories[1].section_title}, ${categories[2].section_title} и ${categories[3].section_title}`;
        } else {
            // Много категорий - показываем первые две и количество остальных
            const remaining = categories.length - 2;
            headerText = `🍣 ${categories[0].section_title}, ${categories[1].section_title} +${remaining} категорий`;
        }
        
        // Ограничиваем длину заголовка (WhatsApp имеет лимиты)
        if (headerText.length > 60) {
            headerText = `${categories.length} категорий (${totalProducts} товаров)`;
        }

        var productListData = {
            messaging_product: "whatsapp",
            to: to,
            type: "interactive",
            interactive: {
                type: "product_list",
                header: {
                    type: "text",
                    text: headerText
                },
                body: {
                    text: `Выберите блюда:`
                },
                footer: {
                    text: "Yaposhkin Rolls"
                },
                action: {
                    catalog_id: catalogId,
                    sections: sections
                }
            }
        };
        if(lan === 'kg'){
            productListData = {
            messaging_product: "whatsapp",
            to: to,
            type: "interactive",
            interactive: {
                type: "product_list",
                header: {
                    type: "text",
                    text: headerText
                },
                body: {
                    text: `Тамактарды танданыз:`
                },
                footer: {
                    text: "Yaposhkin Rolls"
                },
                action: {
                    catalog_id: catalogId,
                    sections: sections
                }
            }
        };
        }
        
        
        console.log(`📤 Отправляем product_list:`);
        console.log(`   📋 Заголовок: ${headerText}`);
        console.log(`   📦 Секций: ${sections.length}`);
        console.log(`   🛍️ Товаров: ${totalProducts}`);
        
        // Детальный вывод товаров по секциям
        sections.forEach(section => {
            console.log(`     📦 ${section.title}: ${section.product_items.length} товаров`);
        });
        
        await sendWhatsAppMessage(phone_no_id, productListData);
        
    } catch (error) {
        console.error("❌ Ошибка отправки product_list с секциями:", error);
        
        // Если не получилось отправить product_list, отправляем обычное сообщение
        const categoryNames = categories.map(cat => cat.section_title).join(', ');
        const fallbackText = `📱 Категории: ${categoryNames}\n\nПосмотрите наш каталог, выбрав меню в чате.`;
        await sendMessage(phone_no_id, to, fallbackText);
    }
}

// Универсальная функция отправки текстового сообщения
async function sendMessage(phone_no_id, to, text) {
    const messageData = {
        messaging_product: "whatsapp",
        to: to,
        text: {
            body: text || "Сообщение"
        }
    };

    return await sendWhatsAppMessage(phone_no_id, messageData);
}

// Flow endpoint обработка
app.post("/flow", async (req, res) => {
    console.log("=== FLOW REQUEST ===");
    console.log("Headers:", JSON.stringify(req.headers, null, 2));
    console.log("Body:", JSON.stringify(req.body, null, 2));

    try {
        const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;

        // Проверяем наличие зашифрованных данных
        if (!encrypted_flow_data || !encrypted_aes_key || !initial_vector) {
            console.log("❌ Missing encryption parameters");
            return res.status(421).json({ error: "Missing encryption parameters" });
        }

        // Расшифровываем данные используя официальный метод
        const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptRequest(req.body);
        
        console.log("✅ Decrypted data:", JSON.stringify(decryptedBody, null, 2));

        // Обрабатываем расшифрованные данные
        const responseData = await processFlowData(decryptedBody);

        // Шифруем ответ используя официальный метод
        const encryptedResponse = encryptResponse(responseData, aesKeyBuffer, initialVectorBuffer);

        console.log("✅ Sending encrypted response");
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send(encryptedResponse);

    } catch (error) {
        console.error("❌ Flow endpoint error:", error);
        return res.status(421).json({ error: "Request processing failed" });
    }
});

// Официальная функция расшифровки от Facebook
const decryptRequest = (body) => {
    const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;
    
    // Получаем приватный ключ
    const privatePem = getPrivateKey();
    if (!privatePem) {
        throw new Error("Private key not found");
    }

    // Расшифровываем AES ключ используя RSA
    const decryptedAesKey = crypto.privateDecrypt(
        {
            key: crypto.createPrivateKey(privatePem),
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
        },
        Buffer.from(encrypted_aes_key, "base64")
    );

    // Расшифровываем Flow данные используя AES-GCM
    const flowDataBuffer = Buffer.from(encrypted_flow_data, "base64");
    const initialVectorBuffer = Buffer.from(initial_vector, "base64");
    
    const TAG_LENGTH = 16;
    const encrypted_flow_data_body = flowDataBuffer.subarray(0, -TAG_LENGTH);
    const encrypted_flow_data_tag = flowDataBuffer.subarray(-TAG_LENGTH);

    const decipher = crypto.createDecipheriv(
        "aes-128-gcm",
        decryptedAesKey,
        initialVectorBuffer
    );
    
    decipher.setAuthTag(encrypted_flow_data_tag);

    const decryptedJSONString = Buffer.concat([
        decipher.update(encrypted_flow_data_body),
        decipher.final(),
    ]).toString("utf-8");

    return {
        decryptedBody: JSON.parse(decryptedJSONString),
        aesKeyBuffer: decryptedAesKey,
        initialVectorBuffer,
    };
};

// Официальная функция шифрования от Facebook
const encryptResponse = (response, aesKeyBuffer, initialVectorBuffer) => {
    // Инвертируем initialization vector (официальная спецификация)
    const flipped_iv = [];
    for (const pair of initialVectorBuffer.entries()) {
        flipped_iv.push(~pair[1]);
    }

    // Шифруем ответ используя AES-GCM
    const cipher = crypto.createCipheriv(
        "aes-128-gcm",
        aesKeyBuffer,
        Buffer.from(flipped_iv)
    );

    const encryptedData = Buffer.concat([
        cipher.update(JSON.stringify(response), "utf-8"),
        cipher.final(),
        cipher.getAuthTag(),
    ]);

    return encryptedData.toString("base64");
};

// Обработка Flow данных
async function processFlowData(data) {
    console.log("🔄 Processing flow data:", data);
    
    try {
        const { version, action, flow_token, data: flowData, screen } = data;
        
        console.log(`Processing: version=${version}, action=${action}, screen=${screen}, token=${flow_token}`);
        console.log("Raw flowData:", flowData);

        switch (action) {
            case "ping":
                console.log("🏓 Health check request");
                return {
                    data: {
                        status: "active"
                    }
                };

            case "INIT":
                console.log("🚀 Flow initialization");
                
                if (flow_token && flow_token.includes("new_customer")) {
                    return {
                        screen: "WELCOME_NEW",
                        data: {
                            flow_type: "new_customer",
                            branches: flowData?.branches || []
                        }
                    };
                } else if (flow_token && flow_token.includes("existing_customer")) {
                    // Для существующих клиентов передаем данные
                    const customerName = flowData?.customer_name || "";
                    const userAddresses = flowData?.user_addresses || [];
                    const branches = flowData?.branches || [];
                    
                    console.log("📍 User addresses from payload:", userAddresses);
                    console.log("👤 Customer name from payload:", customerName);
                    console.log("🏪 Branches from payload:", branches);
                    
                    return {
                        screen: "ORDER_TYPE",
                        data: {
                            flow_type: "existing_customer",
                            customer_name: customerName,
                            user_addresses: userAddresses,
                            branches: branches
                        }
                    };
                }
                
                return {
                    screen: "ORDER_TYPE",
                    data: {}
                };

            case "data_exchange":
                console.log("💾 Data exchange from screen:", screen);
                return await handleDataExchange(screen, flowData, flow_token);

            default:
                console.log("❓ Unknown action, returning default response");
                return {
                    data: {
                        status: "active"
                    }
                };
        }
    } catch (error) {
        console.error("❌ Flow processing error:", error);
        return {
            data: {
                status: "active"
            }
        };
    }
}

// Обработка data_exchange в Flow
async function handleDataExchange(screen, data, flow_token) {
    console.log(`📋 Data exchange for screen: ${screen}`, data);
    
    try {
        switch (screen) {
            case "WELCOME_NEW":
                // Переход с приветствия новых клиентов
                return {
                    screen: "ORDER_TYPE_NEW",
                    data: {
                        flow_type: "new_customer",
                        customer_name: data.customer_name,
                        branches: data.branches
                    }
                };

            case "ORDER_TYPE_NEW":
                // Переход от типа заказа новых клиентов
                return {
                    screen: "DELIVERY_OPTIONS_NEW",
                    data: {
                        flow_type: "new_customer",
                        customer_name: data.customer_name,
                        order_type: data.order_type,
                        branches: data.branches
                    }
                };

            case "DELIVERY_OPTIONS_NEW":
                // Завершение flow новых клиентов
                return {
                    screen: "SUCCESS",
                    data: {
                        extension_message_response: {
                            params: {
                                flow_token: flow_token,
                                flow_type: "new_customer",
                                customer_name: data.customer_name,
                                order_type: data.order_type,
                                branch: data.branch,
                                delivery_address: data.delivery_address
                            }
                        }
                    }
                };

            case "ORDER_TYPE":
                // Переход с первого экрана существующих клиентов
                return {
                    screen: "DELIVERY_OPTIONS",
                    data: {
                        flow_type: "existing_customer",
                        customer_name: data.customer_name,
                        order_type: data.order_type,
                        user_addresses: data.user_addresses,
                        branches: data.branches
                    }
                };

            case "DELIVERY_OPTIONS":
                // Завершение flow существующих клиентов
                return {
                    screen: "SUCCESS",
                    data: {
                        extension_message_response: {
                            params: {
                                flow_token: flow_token,
                                flow_type: "existing_customer",
                                customer_name: data.customer_name,
                                order_type: data.order_type,
                                delivery_choice: data.delivery_choice,
                                new_address: data.new_address,
                                branch: data.branch
                            }
                        }
                    }
                };

            default:
                console.log(`❓ Unknown screen: ${screen}`);
                return {
                    screen: "ORDER_TYPE",
                    data: {}
                };
        }
    } catch (error) {
        console.error("❌ Data exchange error:", error);
        return {
            screen: screen,
            data: {
                error_message: "Произошла ошибка. Попробуйте еще раз."
            }
        };
    }
}

// Получение приватного ключа
function getPrivateKey() {
    try {
        // Сначала пробуем из переменной окружения
        if (process.env.PRIVATE_KEY) {
            console.log("🔑 Using private key from environment");
            return process.env.PRIVATE_KEY.replace(/\\n/g, '\n');
        }
        
        // Потом пробуем из файла
        if (fs.existsSync('./private_key.pem')) {
            console.log("🔑 Using private key from file");
            return fs.readFileSync('./private_key.pem', 'utf8');
        }
        
        console.log("❌ Private key not found");
        return null;
        
    } catch (error) {
        console.error("❌ Error loading private key:", error);
        return null;
    }
}

// GET endpoint для проверки
app.get("/flow", (req, res) => {
    const hasPrivateKey = !!getPrivateKey();
    
    const status = {
        status: "Flow endpoint active",
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
        encryption: {
            privateKeyLoaded: hasPrivateKey,
            algorithm: "Official Facebook implementation: AES-128-GCM + RSA-OAEP-SHA256",
            supportedCiphers: crypto.getCiphers().filter(c => c.includes('gcm')).slice(0, 5)
        }
    };
    
    console.log("📊 Flow status:", status);
    res.status(200).json(status);
});

// POST endpoint для отправки уведомления о статусе заказа
app.post("/order-status", async (req, res) => {
    try {
        console.log("=== ПОЛУЧЕН ЗАПРОС НА ОБНОВЛЕНИЕ СТАТУСА ЗАКАЗА ===");
        console.log("Request body:", JSON.stringify(req.body, null, 2));

        const { 
            phone, 
            order_id, 
            status, 
            order_type, 
            location_title,
            estimated_time,
            additional_info 
        } = req.body;

        // Валидация обязательных полей
        if (!phone || !order_id || !status) {
            return res.status(400).json({
                success: false,
                error: "Обязательные поля: phone, order_id, status"
            });
        }

        // Получаем phone_number_id из переменных окружения
        const phone_no_id = process.env.PHONE_NUMBER_ID;
        if (!phone_no_id) {
            return res.status(500).json({
                success: false,
                error: "PHONE_NUMBER_ID не настроен в переменных окружения"
            });
        }

        // Отправляем уведомление клиенту
        const result = await sendOrderStatusNotification(
            phone_no_id, 
            phone, 
            order_id, 
            status, 
            order_type, 
            location_title,
            estimated_time,
            additional_info
        );

        if (result.success) {
            res.status(200).json({
                success: true,
                message: "Уведомление отправлено успешно",
                whatsapp_message_id: result.message_id
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error
            });
        }

    } catch (error) {
        console.error("❌ Ошибка обработки статуса заказа:", error);
        res.status(500).json({
            success: false,
            error: "Внутренняя ошибка сервера"
        });
    }
});

// Функция отправки уведомления о статусе заказа
async function sendOrderStatusNotification(phone_no_id, customerPhone, orderId, status, orderType = 'pickup', locationTitle = '', estimatedTime = '', additionalInfo = '') {
    try {
        console.log(`📱 Отправляем уведомление о статусе "${status}" для заказа ${orderId} клиенту ${customerPhone}`);

        // Формируем сообщение в зависимости от статуса
        const message = await formatOrderStatusMessage(orderId, status, orderType, locationTitle, estimatedTime, additionalInfo, customerPhone.replace("+", ""));

        // Отправляем сообщение
        const response = await sendMessage(phone_no_id, customerPhone.replace("+", ""), message);

        console.log("✅ Уведомление о статусе заказа отправлено успешно");
        
        return {
            success: true,
            message_id: response.messages?.[0]?.id
        };

    } catch (error) {
        console.error("❌ Ошибка отправки уведомления о статусе:", error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Функция форматирования сообщений для разных статусов
async function formatOrderStatusMessage(orderId, status, orderType, locationTitle, estimatedTime, additionalInfo, from) {
    const emoji = getStatusEmoji(status);
    const statusText = getStatusText(status);

    const lan = await getUserLan(from);
    const userState = await getUserState(from);
    
    let message = ``;
    if(lan==='ru'){
        message += `📋 Заказ №${orderId}\n`;
    }else{
        message += `📋 Буйрутма №${orderId}\n`;
    }

    switch (status.toLowerCase()) {
        case 'accepted':
        case 'подтвержден':
            if(lan==='ru'){
                message += `✅ Ваш заказ подтвержден и принят в работу!\n\n`;
                // message += `\n📞 Если у вас есть вопросы, свяжитесь с нами.`;
            }else{
                message += `✅ Буйрутмаңыз ырасталды жана иштетүүгө кабыл алынды!\n\n`;
                // message += `\n📞 Суроолоруңуз болсо, биз менен байланышыңыз.`;
            }
            // if (orderType === 'delivery') {
            //     message += `🚗 Тип: Доставка\n`;
            //     if (estimatedTime) {
            //         message += `⏰ Ожидаемое время доставки: ${estimatedTime}\n`;
            //     }
            // } else {
            //     message += `🏪 Тип: Самовывоз\n`;
            //     if (locationTitle) {
            //         message += `📍 Филиал: ${locationTitle}\n`;
            //     }
            //     if (estimatedTime) {
            //         message += `⏰ Ожидаемое время готовности: ${estimatedTime}\n`;
            //     }
            // }
            break;

        case 'production':
        case 'Отправлен на кухню':
            if(lan==='ru'){
                message += `👨‍🍳 Наши повара готовят ваш заказ!\n\n`;
                message += `🍣 Мы используем только свежие ингредиенты и готовим с любовью!`;
            }else{
                message += `👨‍🍳 Биздин ашпозчулар буйрутмаңызды даярдап жатышат!\n\n`;
                // message += `🍣 Биз жаңы ингредиенттерди гана колдонобуз!`;
            }
            
            break;

        // case 'COMPLETED':
        // case 'Завершен, но не передан пользователю':
        //     if (orderType === 'delivery') {
        //         message += `🚗 Ваш заказ готов и передан курьеру!\n\n`;
        //         message += `📍 Курьер уже в пути к вам.\n`;
        //         if (estimatedTime) {
        //             message += `⏰ Ожидаемое время доставки: ${estimatedTime}\n`;
        //         }
        //         message += `\n📞 Курьер свяжется с вами перед прибытием.`;
        //     } else {
        //         message += `🎉 Ваш заказ готов к выдаче!\n\n`;
        //         if (locationTitle) {
        //             message += `📍 Филиал: ${locationTitle}\n`;
        //         }
        //         message += `🏪 Приезжайте за заказом в удобное для вас время.\n`;
        //         message += `\n💳 Оплата при получении.`;
        //     }
        //     break;

        case 'out_for_delivery':
        case 'в_доставке':
            message += `🚗 Курьер в пути!\n\n`;
            message += `📍 Ваш заказ доставляется по указанному адресу.\n`;
            message += `\n📞 Курьер свяжется с вами при приближении к адресу.`;
            break;

        case 'delivered':
        case 'доставлен':
            message += `✅ Заказ успешно доставлен!\n\n`;
            message += `🙏 Спасибо за выбор Yaposhkin Rolls!\n`;
            message += `⭐ Будем рады вашему отзыву о качестве блюд и сервисе.\n`;
            message += `\n🍣 Ждем вас снова!`;
            break;

        case 'completed':
        case 'выполнен':
             if(lan==='ru'){
                if(userState){
                    if(userState.order_type === 'delivery'){
                        message += `🎉 Ваш заказ готов и передан курьеру!\n\n`;
                        message += `🙏 Спасибо за выбор Yaposhkin Rolls!\n`;
                        // message += `⭐ Будем рады вашему отзыву о качестве блюд и сервисе.\n`;
                        message += `\n🍣 Ждем вас снова!`;
                    }else{
                        // message += `✅ Заказ выполнен!\n\n`;
                        message += `🎉 Ваш заказ готов к выдаче!\n\n`;
                        message += `🙏 Спасибо за выбор Yaposhkin Rolls!\n`;
                        // message += `⭐ Будем рады вашему отзыву о качестве блюд и сервисе.\n`;
                        message += `\n🍣 Ждем вас снова!`;
                    }
                }else{
                    message += `✅ Заказ выполнен!\n\n`;
                    message += `🙏 Спасибо за выбор Yaposhkin Rolls!\n`;
                    // message += `⭐ Будем рады вашему отзыву о качестве блюд и сервисе.\n`;
                    message += `\n🍣 Ждем вас снова!`;
                }
                
            }else{
                if(userState){
                    if(userState.order_type === 'delivery'){
                        // message += `✅ Буйрутма даяр болду!\n\n`;
                        message += `🎉 Буйрутмаңыз даяр жана курьерге берилди!\n\n`;
                        message += `🙏 Yaposhkin Rolls тандаганыңыз үчүн рахмат!\n`;
                        // message += `⭐ Будем рады вашему отзыву о качестве блюд и сервисе.\n`;
                        message += `\n🍣 Биз сизди дагы күтөбүз!`;
                    }else{
                        // message += `✅ Буйрутма даяр болду!\n\n`;
                        message += `🎉 Буйрутмаңыз алып кетүүгө даяр!\n\n`;
                        message += `🙏 Yaposhkin Rolls тандаганыңыз үчүн рахмат!\n`;
                        // message += `⭐ Будем рады вашему отзыву о качестве блюд и сервисе.\n`;
                        message += `\n🍣 Биз сизди дагы күтөбүз!`;
                    }
                }else{
                    message += `✅ Буйрутма даяр болду!\n\n`;
                // message += `🎉 Буйрутмаңыз алып кетүүгө даяр!\n\n`;
                message += `🙏 Yaposhkin Rolls тандаганыңыз үчүн рахмат!\n`;
                // message += `⭐ Будем рады вашему отзыву о качестве блюд и сервисе.\n`;
                message += `\n🍣 Биз сизди дагы күтөбүз!`;
                }
                
            }
             await deleteUserState(from);
             await clearUserWaitingState(from);
            break;

        case 'cancelled':
        case 'отменен':
            if(lan==='ru'){
                message += `❌ Заказ отменен\n\n`;
                message += `😔 Приносим извинения за неудобства.\n`;
                message += `📞 Если у вас есть вопросы, свяжитесь с нами.\n`;
                message += `\n🍣 Будем рады видеть вас снова!`;
            }else{
                message += `❌ Буйрутма жокко чыгарылды\n\n`;
                message += `😔 Ыңгайсыздык үчүн кечирим сурайбыз.\n`;
                message += `📞 Суроолоруңуз болсо, жогорудагы номер аркылуу биз менен байланышыңыз.\n`;
                message += `\n🍣 Биз сизди дагы бир жолу көрүүнү чыдамсыздык менен күтөбүз!`;
            }
             await deleteUserState(from);
             await clearUserWaitingState(from);
            break;

        case 'delayed':
        case 'задержан':
            message += `⏰ Небольшая задержка заказа\n\n`;
            if (estimatedTime) {
                message += `🕐 Новое ожидаемое время: ${estimatedTime}\n`;
            }
            if (additionalInfo) {
                message += `📝 Причина задержки: ${additionalInfo}\n`;
            }
            message += `\n😔 Приносим извинения за задержку.\n`;
            message += `📞 Если у вас есть вопросы, свяжитесь с нами.`;
            break;

        default:
            message += `📋 Статус заказа обновлен: ${status}\n\n`;
            if (additionalInfo) {
                message += `📝 Дополнительная информация: ${additionalInfo}\n\n`;
            }
            message += `📞 Если у вас есть вопросы, свяжитесь с нами.`;
    }

    // Очищаем состояние
        // await deleteUserState(from);
        // await clearUserWaitingState(from);

    return message;
}

// Функция получения эмодзи для статуса
function getStatusEmoji(status) {
    const emojiMap = {
        'accepted': '✅',
        'подтвержден': '✅',
        'production': '👨‍🍳',
        'готовится': '👨‍🍳',
        'ready': '🎉',
        'готов': '🎉',
        'out_for_delivery': '🚗',
        'в_доставке': '🚗',
        'delivered': '✅',
        'доставлен': '✅',
        'completed': '✅',
        'выполнен': '✅',
        'cancelled': '❌',
        'отменен': '❌',
        'delayed': '⏰',
        'задержан': '⏰'
    };
    
    return emojiMap[status.toLowerCase()] || '📋';
}

// Функция получения текста статуса
function getStatusText(status) {
    const statusMap = {
        'accepted': 'Заказ подтвержден',
        'подтвержден': 'Заказ подтвержден',
        'production': 'Заказ готовится',
        'готовится': 'Заказ готовится',
        'ready': 'Заказ готов',
        'готов': 'Заказ готов',
        'out_for_delivery': 'Заказ в доставке',
        'в_доставке': 'Заказ в доставке',
        'delivered': 'Заказ доставлен',
        'доставлен': 'Заказ доставлен',
        'completed': 'Заказ выполнен',
        'выполнен': 'Заказ выполнен',
        'cancelled': 'Заказ отменен',
        'отменен': 'Заказ отменен',
        'delayed': 'Заказ задержан',
        'задержан': 'Заказ задержан'
    };
    
    return statusMap[status.toLowerCase()] || `Статус: ${status}`;
}

// Endpoint для получения статистики состояний пользователей
app.get("/stats", async (req, res) => {
    try {
        console.log("=== ЗАПРОС СТАТИСТИКИ ===");
        
        const stats = await getUserStatesStats();
        
        console.log("📊 Статистика состояний:", stats);
        
        res.status(200).json({
            success: true,
            timestamp: new Date().toISOString(),
            database: {
                connected: !!db,
                name: DB_NAME
            },
            statistics: stats
        });
        
    } catch (error) {
        console.error("❌ Ошибка получения статистики:", error);
        res.status(500).json({
            success: false,
            error: "Ошибка получения статистики"
        });
    }
});

// Endpoint для очистки старых состояний пользователей
app.delete("/cleanup", async (req, res) => {
    try {
        console.log("=== ОЧИСТКА СТАРЫХ СОСТОЯНИЙ ===");
        
        // Удаляем состояния старше 24 часов
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        
        const result = await userStatesCollection.deleteMany({
            updatedAt: { $lt: oneDayAgo }
        });
        
        console.log(`🗑️ Удалено ${result.deletedCount} старых состояний`);
        
        res.status(200).json({
            success: true,
            message: `Удалено ${result.deletedCount} старых состояний`,
            deletedCount: result.deletedCount
        });
        
    } catch (error) {
        console.error("❌ Ошибка очистки состояний:", error);
        res.status(500).json({
            success: false,
            error: "Ошибка очистки состояний"
        });
    }
});

// Главная страница
app.get("/", (req, res) => {
    res.status(200).json({
        message: "WhatsApp Bot с MongoDB",
        status: "active",
        version: "2.0.0",
        database: {
            connected: !!db,
            name: DB_NAME
        },
        features: [
            "MongoDB для состояний пользователей",
            "Автоматическое удаление старых записей",
            "Статистика использования",
            "Flow обработка",
            "Каталог товаров",
            "Уведомления о заказах"
        ],
        endpoints: {
            webhook: "/webhook",
            flow: "/flow",
            orderStatus: "/order-status",
            stats: "/stats",
            cleanup: "/cleanup"
        }
    });
});

// Graceful shutdown для MongoDB
process.on('SIGINT', async () => {
    console.log('\n🛑 Получен сигнал завершения...');
    
    if (db) {
        console.log('📦 Закрываем соединение с MongoDB...');
        await db.client.close();
        console.log('✅ Соединение с MongoDB закрыто');
    }
    
    console.log('👋 Сервер завершен');
    process.exit(0);
});

// Обработка ошибок подключения к MongoDB
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Необработанное отклонение промиса:', reason);
    console.error('В промисе:', promise);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Необработанное исключение:', error);
    process.exit(1);
});