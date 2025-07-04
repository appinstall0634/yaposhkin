const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const PORT = process.env.PORT || 3000;

const app = express().use(body_parser.json());

const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN;

// Конфигурация
const TEMIR_API_BASE = 'https://ya.temir.me';

// Flow IDs
const NEW_CUSTOMER_FLOW_ID = '4265839023734503'; // newCustomer
const ORDER_FLOW_ID = '708820881926236'; // order

// Состояния пользователей для отслеживания процесса
const userStates = new Map();

// Добавляем новый Map для отслеживания состояния ожидания
const userWaitingStates = new Map();

// Возможные состояния ожидания
const WAITING_STATES = {
    NONE: 'none',                    // Принимаем любые сообщения
    FLOW_RESPONSE: 'flow_response',  // Ожидаем ТОЛЬКО ответ от Flow (nfm_reply)
    LOCATION: 'location',            // Ожидаем ТОЛЬКО местоположение (location)
    CATALOG_ORDER: 'catalog_order',  // Ожидаем ТОЛЬКО ответ от каталога (order/product_list_reply)
    BUTTON_RESPONSE: 'button_response' // Ожидаем ТОЛЬКО ответ от кнопок (button_reply)
};

app.listen(PORT, () => {
    console.log("webhook is listening");
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});

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

            // Получаем текущее состояние ожидания пользователя
            const currentWaitingState = getUserWaitingState(from);
            console.log(`👤 Текущее состояние ожидания для ${from}: ${currentWaitingState}`);

            try {
                // СТРОГАЯ ПРОВЕРКА СОСТОЯНИЙ ОЖИДАНИЯ
                const messageProcessed = await processMessageByWaitingState(
                    phone_no_id, 
                    from, 
                    message, 
                    currentWaitingState, 
                    body_param
                );

                if (!messageProcessed) {
                    // Сообщение не было обработано - отправляем информационное сообщение
                    await sendWaitingStateMessage(phone_no_id, from, currentWaitingState);
                }

            } catch (error) {
                console.error("Ошибка обработки сообщения:", error);
                // При ошибке очищаем состояние и позволяем начать заново
                clearUserWaitingState(from);
                await sendMessage(phone_no_id, from, "Произошла ошибка. Отправьте любое сообщение для начала заново.");
            }

            res.sendStatus(200);
        } else {
            res.sendStatus(404);
        }
    }
});

// Функции для управления состояниями ожидания
function setUserWaitingState(phone, state, timeout = 300000) { // 5 минут по умолчанию
    console.log(`🔄 Устанавливаем состояние ожидания для ${phone}: ${state}`);
    
    // Очищаем предыдущий таймаут если есть
    const currentState = userWaitingStates.get(phone);
    if (currentState && currentState.timeout) {
        clearTimeout(currentState.timeout);
    }
    
    // Устанавливаем таймаут для автоматической очистки состояния
    const timeoutId = setTimeout(() => {
        console.log(`⏰ Таймаут состояния ожидания для ${phone}: ${state}`);
        clearUserWaitingState(phone);
        // Можно отправить сообщение о таймауте
        sendTimeoutMessage(phone, state);
    }, timeout);
    
    userWaitingStates.set(phone, {
        state: state,
        timestamp: Date.now(),
        timeout: timeoutId
    });
}


function clearUserWaitingState(phone) {
    console.log(`✅ Очищаем состояние ожидания для ${phone}`);
    const currentState = userWaitingStates.get(phone);
    if (currentState && currentState.timeout) {
        clearTimeout(currentState.timeout);
    }
    userWaitingStates.delete(phone);
}

function clearAllWaitingStates() {
    console.log("🧹 Очищаем все состояния ожидания");
    for (const [phone, stateObj] of userWaitingStates) {
        if (stateObj.timeout) {
            clearTimeout(stateObj.timeout);
        }
    }
    userWaitingStates.clear();
}

function getWaitingStatesStats() {
    const stats = {
        total: userWaitingStates.size,
        states: {}
    };
    
    for (const [phone, stateObj] of userWaitingStates) {
        const state = stateObj.state;
        stats.states[state] = (stats.states[state] || 0) + 1;
    }
    
    console.log("📊 Статистика состояний ожидания:", stats);
    return stats;
}

function getUserWaitingState(phone) {
    const stateObj = userWaitingStates.get(phone);
    return stateObj ? stateObj.state : WAITING_STATES.NONE;
}

async function sendTimeoutMessage(phone, state) {
    try {
        const phone_no_id = process.env.PHONE_NUMBER_ID;
        let message = '';
        
        switch (state) {
            case WAITING_STATES.FLOW_RESPONSE:
                message = '⏰ Время ожидания истекло. Начните заново, отправив любое сообщение.';
                break;
            case WAITING_STATES.LOCATION:
                message = '⏰ Время ожидания местоположения истекло. Отправьте любое сообщение для повторной попытки.';
                break;
            case WAITING_STATES.CATALOG_ORDER:
                message = '⏰ Время выбора товаров истекло. Отправьте любое сообщение для получения нового каталога.';
                break;
            default:
                message = '⏰ Время ожидания истекло. Отправьте любое сообщение для продолжения.';
        }
        
        await sendMessage(phone_no_id, phone, message);
    } catch (error) {
        console.error('❌ Ошибка отправки сообщения о таймауте:', error);
    }
}



async function processMessageByWaitingState(phone_no_id, from, message, waitingState, body_param) {
    console.log(`🔍 Проверяем сообщение типа "${message.type}" против ожидаемого состояния "${waitingState}"`);

    switch (waitingState) {
        case WAITING_STATES.NONE:
            // Принимаем любые сообщения - обычная обработка
            console.log("✅ Свободное состояние - обрабатываем любое сообщение");
            await handleIncomingMessage(phone_no_id, from, message);
            return true;

        case WAITING_STATES.FLOW_RESPONSE:
            // Ожидаем ТОЛЬКО ответ от Flow
            if (message.type === "interactive" && message.interactive.type === "nfm_reply") {
                console.log("✅ Получен ожидаемый ответ от Flow");
                await handleFlowResponse(phone_no_id, from, message, body_param);
                return true;
            } else {
                console.log("❌ Ожидаем ответ от Flow, но получили другой тип сообщения");
                return false;
            }

        case WAITING_STATES.LOCATION:
            // Ожидаем ТОЛЬКО местоположение
            if (message.type === "location") {
                console.log("✅ Получено ожидаемое местоположение");
                await handleLocationMessage(phone_no_id, from, message);
                return true;
            } else {
                console.log("❌ Ожидаем местоположение, но получили другой тип сообщения");
                return false;
            }

        case WAITING_STATES.CATALOG_ORDER:
            // Ожидаем ТОЛЬКО ответ от каталога
            if (message.type === "order") {
                console.log("✅ Получен ожидаемый заказ из каталога (order)");
                await handleCatalogOrderResponse(phone_no_id, from, message);
                return true;
            } else if (message.type === "interactive" && message.interactive.type === "product_list_reply") {
                console.log("✅ Получен ожидаемый ответ от каталога (product_list_reply)");
                await handleCatalogResponse(phone_no_id, from, message);
                return true;
            } else {
                console.log("❌ Ожидаем выбор товаров из каталога, но получили другой тип сообщения");
                return false;
            }

        case WAITING_STATES.BUTTON_RESPONSE:
            // Ожидаем ТОЛЬКО ответ от кнопок
            if (message.type === "interactive" && message.interactive.type === "button_reply") {
                console.log("✅ Получен ожидаемый ответ от кнопки");
                await handleButtonResponse(phone_no_id, from, message);
                return true;
            } else {
                console.log("❌ Ожидаем ответ от кнопки, но получили другой тип сообщения");
                return false;
            }

        default:
            console.log(`❓ Неизвестное состояние ожидания: ${waitingState}`);
            // При неизвестном состоянии очищаем его и обрабатываем сообщение
            clearUserWaitingState(from);
            await handleIncomingMessage(phone_no_id, from, message);
            return true;
    }
}

// Отправка информационного сообщения о том, чего мы ожидаем
async function sendWaitingStateMessage(phone_no_id, from, waitingState) {
    let message = '';
    
    switch (waitingState) {
        case WAITING_STATES.FLOW_RESPONSE:
            message = '⏳ Пожалуйста, заполните форму выше и нажмите кнопку для продолжения.';
            break;
            
        case WAITING_STATES.LOCATION:
            message = '📍 Пожалуйста, поделитесь своим местоположением.\n\nНажмите на скрепку 📎 → Местоположение 📍 → Отправить текущее местоположение';
            break;
            
        case WAITING_STATES.CATALOG_ORDER:
            message = '🛒 Пожалуйста, выберите товары из каталога выше и добавьте их в корзину.';
            break;
            
        case WAITING_STATES.BUTTON_RESPONSE:
            message = '🔘 Пожалуйста, выберите один из вариантов, нажав на кнопку выше.';
            break;
            
        default:
            return; // Не отправляем сообщение для неизвестных состояний
    }
    
    try {
        await sendMessage(phone_no_id, from, message);
    } catch (error) {
        console.error('❌ Ошибка отправки информационного сообщения:', error);
    }
}


// Обработка местоположения
async function handleLocationMessage(phone_no_id, from, message) {
    try {
        console.log("=== ОБРАБОТКА МЕСТОПОЛОЖЕНИЯ ===");
        
        // Сразу очищаем состояние ожидания местоположения
        clearUserWaitingState(from);
        
        const location = message.location;
        const longitude = location.longitude;
        const latitude = location.latitude;
        
        console.log(`📍 Получено местоположение: ${latitude}, ${longitude}`);
        
        // Получаем состояние пользователя
        const userState = userStates.get(from);
        
        if (!userState) {
            console.log("❌ Состояние пользователя не найдено");
            await sendMessage(phone_no_id, from, "Произошла ошибка. Попробуйте заново оформить заказ.");
            return;
        }
        
        console.log("👤 Состояние пользователя:", userState);
        
        // Обновляем клиента с новым адресом
        await updateCustomerWithLocation(phone_no_id, from, userState, longitude, latitude);
        
    } catch (error) {
        console.error("❌ Ошибка обработки местоположения:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при сохранении адреса. Попробуйте еще раз.");
        clearUserWaitingState(from);
    }
}

// Обновление клиента с местоположением
async function updateCustomerWithLocation(phone_no_id, from, userState, longitude, latitude) {
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
        
        // ОБНОВЛЯЕМ состояние вместо очистки
        userStates.set(from, {
            ...userState,
            order_type: 'delivery',
            delivery_choice: 'new',
            location_processed: true,
            new_address: userState.delivery_address
        });
        
        // Отправляем подтверждение
        if (userState.flow_type === 'new_customer') {
            const confirmText = `Спасибо за регистрацию, ${userState.customer_name}! 🎉\n\nВаш адрес сохранен: ${userState.delivery_address}\n\nТеперь вы можете делать заказы. Сейчас отправлю вам наш каталог! 🍣`;
            await sendMessage(phone_no_id, from, confirmText);
        } else {
            const confirmText = `✅ Новый адрес добавлен!\n\n📍 ${userState.delivery_address}\n\nТеперь выберите блюда из каталога:`;
            await sendMessage(phone_no_id, from, confirmText);
        }
        
        // ВАЖНО: После успешного обновления отправляем каталог и устанавливаем новое состояние ожидания
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
        userStates.delete(from);
        clearUserWaitingState(from);
    }
}
// Обработка входящих сообщений - проверка клиента
async function handleIncomingMessage(phone_no_id, from, message) {
    console.log("=== ПРОВЕРКА КЛИЕНТА ===");
    
    const messageText = message.text?.body?.toLowerCase();
    
    // Проверяем если это команда для заказа или любое текстовое сообщение
    console.log(`Получено сообщение от ${from}: ${messageText || 'не текст'}`);
    
    await checkCustomerAndSendFlow(phone_no_id, from);
}

// Проверка клиента и отправка соответствующего Flow
async function checkCustomerAndSendFlow(phone_no_id, from) {
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
            await sendNewCustomerFlow(phone_no_id, from, branches);
        } else {
            console.log('✅ Существующий клиент - отправляем Flow с адресами');
            await sendExistingCustomerFlow(phone_no_id, from, customerData.customer, branches);
        }

        // Устанавливаем состояние ожидания ответа от Flow
        setUserWaitingState(from, WAITING_STATES.FLOW_RESPONSE);

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
            setUserWaitingState(from, WAITING_STATES.FLOW_RESPONSE);
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
    
    // ВАЖНО: Устанавливаем состояние ожидания Flow
    setUserWaitingState(from, WAITING_STATES.FLOW_RESPONSE, 600000); // 10 минут для заполнения формы
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
                text: `Привет, ${customer.first_name}! Настройте детали заказа`
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
                    flow_cta: "Настроить заказ",
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
    
    // ВАЖНО: Устанавливаем состояние ожидания Flow
    setUserWaitingState(from, WAITING_STATES.FLOW_RESPONSE, 600000); // 10 минут для заполнения формы
}

// Обработка ответов Flow
async function handleFlowResponse(phone_no_id, from, message, body_param) {
    try {
        console.log("=== ОБРАБОТКА FLOW ОТВЕТА ===");
        
        // Сразу очищаем состояние ожидания Flow
        clearUserWaitingState(from);
        
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
            await sendMessage(phone_no_id, from, "Спасибо! Выберите блюда из каталога:");
            await sendCatalog(phone_no_id, from);
        }

    } catch (error) {
        console.error("Ошибка обработки Flow ответа:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при обработке формы. Попробуйте еще раз.");
        clearUserWaitingState(from);
    }
}

// Обработка регистрации нового клиента
async function handleNewCustomerRegistration(phone_no_id, from, data) {
    try {
        console.log('📝 Регистрируем нового клиента:', data);

        // Если выбрана доставка и есть новый адрес - запрашиваем местоположение
        if (data.order_type === 'delivery' && data.delivery_address) {
            // Сохраняем состояние для ожидания местоположения
            userStates.set(from, {
                flow_type: 'new_customer',
                customer_name: data.customer_name,
                delivery_address: data.delivery_address
            });

            // Отправляем запрос местоположения (внутри функции уже устанавливается состояние ожидания)
            await sendLocationRequest(phone_no_id, from, data.customer_name);
        } else {
            // Самовывоз - сразу регистрируем и отправляем каталог
            await registerCustomerWithoutLocation(phone_no_id, from, data);
        }

    } catch (error) {
        console.error('❌ Ошибка регистрации:', error);
        await sendMessage(phone_no_id, from, 'Извините, произошла ошибка при регистрации. Попробуйте позже.');
        clearUserWaitingState(from);
    }
}

// Регистрация клиента без местоположения (для самовывоза)
async function registerCustomerWithoutLocation(phone_no_id, from, data) {
    try {
        console.log("=== РЕГИСТРАЦИЯ КЛИЕНТА БЕЗ МЕСТОПОЛОЖЕНИЯ ===");
        
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
        await sendMessage(phone_no_id, from, confirmText);
        
        // ВАЖНО: Отправляем каталог (внутри функции уже устанавливается состояние ожидания)
        await sendCatalog(phone_no_id, from);
        
    } catch (error) {
        console.error("❌ Ошибка регистрации без местоположения:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при регистрации. Попробуйте еще раз.");
        clearUserWaitingState(from);
    }
}


// Обработка заказа существующего клиента
async function handleExistingCustomerOrder(phone_no_id, from, data) {
    try {
        console.log('🛒 Обрабатываем заказ существующего клиента:', data);
        
        // Сохраняем данные заказа для дальнейшего использования
        userStates.set(from, {
            flow_type: 'existing_customer',
            order_type: data.order_type,
            delivery_choice: data.delivery_choice,
            new_address: data.new_address,
            branch: data.branch,
            customer_name: data.customer_name
        });
        
        // Проверяем что выбрал клиент
        if (data.order_type === 'delivery' && data.delivery_choice === 'new' && data.new_address) {
            console.log('📍 Клиент выбрал доставку с новым адресом:', data.new_address);
            
            // Обновляем состояние для запроса местоположения, СОХРАНЯЯ ВСЕ ДАННЫЕ
            userStates.set(from, {
                flow_type: 'existing_customer',
                customer_name: data.customer_name || 'Клиент',
                delivery_address: data.new_address,
                // ВАЖНО: сохраняем все данные заказа
                order_type: data.order_type,
                delivery_choice: data.delivery_choice,
                new_address: data.new_address,
                branch: data.branch
            });
            
            // Отправляем запрос местоположения (внутри функции уже устанавливается состояние ожидания)
            await sendLocationRequest(phone_no_id, from, data.customer_name);
            
        } else {
            console.log('✅ Клиент выбрал существующий адрес или самовывоз - отправляем каталог');
            
            // Формируем сообщение в зависимости от типа заказа
            let confirmText;
            if (data.order_type === 'delivery') {
                confirmText = `✅ Отлично! Заказ будет доставлен по выбранному адресу.\n\nВыберите блюда из каталога:`;
            } else {
                confirmText = `✅ Отлично! Вы выбрали самовывоз.\n\nВыберите блюда из каталога:`;
            }
            
            await sendMessage(phone_no_id, from, confirmText);
            
            // ВАЖНО: Отправляем каталог (внутри функции уже устанавливается состояние ожидания)
            await sendCatalog(phone_no_id, from);
        }
        
    } catch (error) {
        console.error('❌ Ошибка обработки заказа:', error);
        await sendMessage(phone_no_id, from, 'Извините, произошла ошибка. Попробуйте еще раз.');
        clearUserWaitingState(from);
    }
}

// Отправка запроса местоположения
async function sendLocationRequest(phone_no_id, from, customerName) {
    console.log("=== ЗАПРОС МЕСТОПОЛОЖЕНИЯ ===");
    
    const locationText = `Спасибо, ${customerName}! 📍\n\nДля точной доставки, пожалуйста, поделитесь своим местоположением.\n\nНажмите на скрепку 📎 → Местоположение 📍 → Отправить текущее местоположение`;
    
    await sendMessage(phone_no_id, from, locationText);
    
    // ВАЖНО: Устанавливаем состояние ожидания местоположения
    setUserWaitingState(from, WAITING_STATES.LOCATION, 300000); // 5 минут на отправку местоположения
}

// Обработка ответа от каталога в формате order
async function handleCatalogOrderResponse(phone_no_id, from, message) {
    try {
        console.log("=== ОТВЕТ ОТ КАТАЛОГА (ORDER FORMAT) ===");
        
        // Сразу очищаем состояние ожидания каталога
        clearUserWaitingState(from);
        
        console.log("Order message:", JSON.stringify(message, null, 2));
        
        const order = message.order;
        
        // Формируем информацию о заказе
        let orderSummary = "🛒 Ваш заказ:\n\n";
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
                orderSummary += `Количество: ${item.quantity} ${productInfo.measure_unit || 'шт'}\n`;
                orderSummary += `Цена: ${itemPrice} KGS x ${item.quantity} = ${itemTotal} KGS\n\n`;
                
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
        orderSummary += `💰 Общая стоимость: ${totalAmount} KGS\n\n`;
        
        // Получаем состояние пользователя для определения типа заказа
        const userState = userStates.get(from);
        
        // Рассчитываем доставку и оформляем заказ
        await calculateDeliveryAndSubmitOrder(phone_no_id, from, orderItems, totalAmount, orderSummary, userState);
        
    } catch (error) {
        console.error("Ошибка обработки order ответа каталога:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при обработке заказа. Попробуйте еще раз.");
        clearUserWaitingState(from);
    }
}

// Расчет доставки и оформление заказа
async function calculateDeliveryAndSubmitOrder(phone_no_id, from, orderItems, totalAmount, orderSummary, userState) {
    try {
        console.log("=== РАСЧЕТ ДОСТАВКИ И ОФОРМЛЕНИЕ ЗАКАЗА ===");
        console.log("User state from parameter:", userState);
        
        // Если userState пустой, пытаемся получить из Map
        if (!userState) {
            console.log("⚠️ User state is null, trying to get from Map");
            userState = userStates.get(from);
            console.log("User state from Map:", userState);
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
                userStates.delete(from);
                clearUserWaitingState(from);
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
                    userStates.delete(from);
                    clearUserWaitingState(from);
                    return; 
                }
            } catch (deliveryError) {
                console.error("❌ Ошибка запроса доставки:", deliveryError);
                await sendMessage(phone_no_id, from, "❌ Произошла ошибка при расчете стоимости доставки. Попробуйте позже или обратитесь к менеджеру.");
                userStates.delete(from);
                clearUserWaitingState(from);
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
                    await sendMessage(phone_no_id, from, "❌ Ошибка: выбранный филиал недоступен. Попробуйте заново или обратитесь к менеджеру.");
                    userStates.delete(from);
                    clearUserWaitingState(from);
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
                        await sendMessage(phone_no_id, from, "❌ Извините, в данный момент нет доступных филиалов для самовывоза. Обратитесь к менеджеру.");
                        userStates.delete(from);
                        clearUserWaitingState(from);
                        return;
                    }
                } catch (error) {
                    console.error("❌ Ошибка получения списка филиалов:", error);
                    await sendMessage(phone_no_id, from, "❌ Ошибка получения информации о филиалах. Попробуйте позже или обратитесь к менеджеру.");
                    userStates.delete(from);
                    clearUserWaitingState(from);
                    return;
                }
            }
        }
        
        // Проверяем что у нас есть locationId
        if (!locationId) {
            console.log("❌ Не удалось определить локацию для заказа");
            await sendMessage(phone_no_id, from, "❌ Ошибка определения места выполнения заказа. Обратитесь к менеджеру.");
            userStates.delete(from);
            clearUserWaitingState(from);
            return;
        }
        
        const finalAmount = totalAmount + deliveryCost;
        
        // Показываем итоговую стоимость
        let costMessage = orderSummary;
        
        if (orderType === "delivery") {
            costMessage += `🚚 Стоимость доставки: ${deliveryCost} KGS\n`;
            costMessage += `📍 Адрес доставки: ${deliveryAddress}\n\n`;
        } else {
            costMessage += `🏪 Самовывоз: 0 KGS\n`;
            costMessage += `📍 Филиал: ${locationTitle}\n\n`;
        }
        
        costMessage += `💰 Общая стоимость: ${finalAmount} KGS\n\n`;
        costMessage += `⏳ Оформляем ваш заказ...`;
        
        await sendMessage(phone_no_id, from, costMessage);
        
        // Оформляем заказ
        await submitOrder(phone_no_id, from, orderItems, customerData, locationId, locationTitle, orderType, finalAmount);
        
        // Очищаем состояние ТОЛЬКО после успешного оформления заказа
        userStates.delete(from);
        clearUserWaitingState(from);
        
    } catch (error) {
        console.error("❌ Ошибка расчета доставки и оформления заказа:", error);
        await sendMessage(phone_no_id, from, "❌ Произошла критическая ошибка при оформлении заказа. Наш менеджер свяжется с вами.");
        userStates.delete(from);
        clearUserWaitingState(from);
    }
}

// Отправка заказа в API
async function submitOrder(phone_no_id, from, orderItems, customerData, locationId, locationTitle, orderType, finalAmount) {
    try {
        console.log("📝 Отправляем заказ в API");
        
        // Формируем данные для preorder
        const preorderData = {
            locationId: parseInt(locationId),
            locationTitle: locationTitle,
            type: orderType,
            customerContact: {
                firstName: "Test",
                comment: "Test",
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
        await sendOrderSuccessMessage(phone_no_id, from, preorderResponse.data, orderType, finalAmount, locationTitle);

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
                    errorMessage = `⏰ К сожалению, доставка сейчас недоступна.\n\n`;
                    errorMessage += `🏪 Филиал "${locationTitle}" закрыт.\n`;
                    if (workingHours) {
                        errorMessage += `🕐 Режим работы: ${workingHours}\n\n`;
                    }
                    errorMessage += `Вы можете оформить заказ в рабочее время или связаться с нашим менеджером.`;
                } else {
                    errorMessage = `⏰ К сожалению, самовывоз сейчас недоступен.\n\n`;
                    errorMessage += `🏪 Филиал "${locationTitle}" закрыт.\n`;
                    if (workingHours) {
                        errorMessage += `🕐 Режим работы: ${workingHours}\n\n`;
                    }
                    errorMessage += `Вы можете забрать заказ в рабочее время или связаться с нашим менеджером.`;
                }
            } else if (errorDescription.includes("out of stock") || errorDescription.includes("unavailable")) {
                // Товар недоступен
                errorMessage = `❌ К сожалению, некоторые товары из вашего заказа сейчас недоступны.\n\n`;
                errorMessage += `Попробуйте выбрать другие блюда из каталога или свяжитесь с нашим менеджером для уточнения наличия.`;
            } else {
                // Другие ошибки API
                errorMessage = `❌ Ошибка оформления заказа: ${errorDescription}\n\n`;
                errorMessage += `Наш менеджер свяжется с вами для решения проблемы.`;
            }
        } else if (error.response?.data?.error?.type) {
            // Обработка ошибок по типу
            const errorType = error.response.data.error.type;
            
            if (errorType === "LocationIsClosedException") {
                console.log("🔒 Филиал закрыт (по типу ошибки)");
                
                const workingHours = await getLocationWorkingHours(locationId);
                
                errorMessage = `⏰ К сожалению, ${orderType === 'delivery' ? 'доставка' : 'самовывоз'} сейчас недоступен.\n\n`;
                errorMessage += `🏪 Филиал "${locationTitle}" закрыт.\n`;
                if (workingHours) {
                    errorMessage += `🕐 Режим работы: ${workingHours}\n\n`;
                }
                errorMessage += `Вы можете оформить заказ в рабочее время или связаться с нашим менеджером.`;
            } else {
                errorMessage = `❌ Ошибка: ${errorType}\n\n`;
                errorMessage += `Наш менеджер свяжется с вами для решения проблемы.`;
            }
        } else if (error.response?.status === 400) {
            errorMessage = `❌ Ошибка в данных заказа.\n\n`;
            errorMessage += `Попробуйте оформить заказ заново или обратитесь к менеджеру.`;
        } else if (error.response?.status === 404) {
            errorMessage = `❌ Выбранный филиал временно недоступен.\n\n`;
            errorMessage += `Попробуйте позже или обратитесь к менеджеру.`;
        } else if (error.response?.status === 500) {
            errorMessage = `❌ Технические неполадки на сервере.\n\n`;
            errorMessage += `Мы уже работаем над решением проблемы. Попробуйте через несколько минут.`;
        } else {
            errorMessage = `❌ Произошла ошибка при оформлении заказа.\n\n`;
            errorMessage += `Наш менеджер свяжется с вами для уточнения деталей.`;
        }
        
        await sendMessage(phone_no_id, from, errorMessage);
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
async function sendOrderSuccessMessage(phone_no_id, from, preorderResponse, orderType, finalAmount, locationTitle) {
    try {
        let successMessage = '';
        
        if (preorderResponse.status === 'success') {
            successMessage = '🎉 Ваш заказ принят!\n\n';
            successMessage += `📋 Номер заказа: ${preorderResponse.data.preorder_id}\n\n`;
            
            if (orderType === 'pickup') {
                successMessage += `🏪 Самовывоз из филиала:\n`;
                successMessage += `📍 ${locationTitle}\n`;
            } else {
                successMessage += `🚗 Доставка по вашему адресу\n`;
            }

            successMessage += `💰 Сумма к оплате: ${finalAmount} KGS\n\n`;
            successMessage += '⏳ Ожидайте звонка от нашего менеджера для подтверждения деталей.\n\n';
            successMessage += '📞 Если у вас есть вопросы, вы можете связаться с нами по телефону или написать в этот чат.';
        } else {
            successMessage = '❌ Произошла ошибка при оформлении заказа.\n';
            successMessage += 'Наш менеджер свяжется с вами для уточнения деталей.';
        }

        await sendMessage(phone_no_id, from, successMessage);
        
    } catch (error) {
        console.error('❌ Ошибка отправки сообщения об успехе:', error);
    }
}

// Остальные функции...
async function handleButtonResponse(phone_no_id, from, message) {
    try {
        console.log("=== ОТВЕТ ОТ КНОПКИ ===");
        
        // Если мы ожидали ответ от кнопки, очищаем состояние
        if (getUserWaitingState(from) === WAITING_STATES.BUTTON_RESPONSE) {
            clearUserWaitingState(from);
        }
        
        const buttonId = message.interactive.button_reply.id;
        
        // Обрабатываем нажатие кнопок если нужно
        console.log("Button ID:", buttonId);
        
        // Здесь можно добавить обработку конкретных кнопок
        
    } catch (error) {
        console.error("Ошибка обработки ответа кнопки:", error);
    }
}

async function sendButtonMessage(phone_no_id, to, bodyText, buttons, headerText = null, footerText = null, timeoutMinutes = 5) {
    try {
        const interactiveData = {
            messaging_product: "whatsapp",
            to: to,
            type: "interactive",
            interactive: {
                type: "button",
                body: {
                    text: bodyText
                },
                action: {
                    buttons: buttons
                }
            }
        };
        
        // Добавляем заголовок если есть
        if (headerText) {
            interactiveData.interactive.header = {
                type: "text",
                text: headerText
            };
        }
        
        // Добавляем подпись если есть
        if (footerText) {
            interactiveData.interactive.footer = {
                text: footerText
            };
        }
        
        await sendWhatsAppMessage(phone_no_id, interactiveData);
        
        // ВАЖНО: Автоматически устанавливаем состояние ожидания кнопки
        setUserWaitingState(to, WAITING_STATES.BUTTON_RESPONSE, timeoutMinutes * 60 * 1000);
        
        console.log(`✅ Отправлены кнопки с установкой состояния ожидания на ${timeoutMinutes} минут`);
        
    } catch (error) {
        console.error("❌ Ошибка отправки кнопок:", error);
        throw error;
    }
}

async function resetUserState(phone_no_id, from, reason = "Сброс состояния") {
    console.log(`🔄 Сбрасываем состояние пользователя ${from}: ${reason}`);
    
    // Очищаем все состояния
    clearUserWaitingState(from);
    userStates.delete(from);
    
    // Отправляем сообщение и начинаем заново
    await sendMessage(phone_no_id, from, "🔄 Начинаем заново. Отправьте любое сообщение для продолжения.");
}

function cleanupExpiredStates() {
    const now = Date.now();
    const maxAge = 3600000; // 1 час
    let cleanedCount = 0;
    
    for (const [phone, stateObj] of userWaitingStates) {
        if (now - stateObj.timestamp > maxAge) {
            console.log(`🧹 Очищаем устаревшее состояние для ${phone}`);
            clearUserWaitingState(phone);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        console.log(`✅ Очищено ${cleanedCount} устаревших состояний`);
    }
    
    return cleanedCount;
}

function logUserStateChange(phone, action, oldState, newState) {
    const timestamp = new Date().toISOString();
    console.log(`📝 [${timestamp}] ${phone}: ${action} | ${oldState} → ${newState}`);
    
    // Здесь можно добавить запись в базу данных или файл для аналитики
}

async function handleCatalogResponse(phone_no_id, from, message) {
    try {
        console.log("=== ОТВЕТ ОТ КАТАЛОГА (PRODUCT LIST) ===");
        
        // Сразу очищаем состояние ожидания каталога
        clearUserWaitingState(from);
        
        console.log("Catalog response:", JSON.stringify(message.interactive, null, 2));
        
        // Этот тип ответа каталога используется редко
        // Основной формат - order в handleCatalogOrderResponse
        await sendMessage(phone_no_id, from, "Спасибо за выбор! Обрабатываем ваш заказ...");
        
    } catch (error) {
        console.error("Ошибка обработки ответа каталога:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при обработке заказа. Попробуйте еще раз.");
        clearUserWaitingState(from);
    }
}

// Кэш товаров для оптимизации
let productsCache = null;
let cacheExpiry = null;

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
            productsMap[product.api_id] = {
                id: product.api_id,
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
            url: `https://graph.facebook.com/v22.0/${phone_no_id}/messages?access_token=${token}`,
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

// // Отправка каталога
// async function sendCatalog(phone_no_id, to) {
//     console.log("=== ОТПРАВКА КАТАЛОГА ===");
    
//     const catalogData = {
//         messaging_product: "whatsapp",
//         to: to,
//         type: "interactive",
//         interactive: {
//             type: "catalog_message",
//             body: {
//                 text: "🍣 Наш полный каталог Yaposhkin Rolls!\n\nВыберите понравившиеся блюда и добавьте в корзину. Все товары свежие и готовятся с любовью! ❤️"
//             },
//             footer: {
//                 text: "Доставка 30-40 минут"
//             },
//             action: {
//                 name: "catalog_message"
//             }
//         }
//     };

//     await sendWhatsAppMessage(phone_no_id, catalogData);
// }

// ЗАМЕНИТЕ ЭТУ ЧАСТЬ В ВАШЕМ КОДЕ:
// Найдите секцию с menuCategories и замените её на это:

// Оптимизированные группы товаров (6 сообщений вместо 12)
const optimizedMenuGroups = [
    // Группа 1: Роллы (первые 30)
    [
        {
            title: "Роллы",
            productIds: [
                "71", "46", "54", "58", "63", "62", "60", "61", "49", "48", 
                "47", "50", "53", "72", "67", "70", "68", "69", "52", "51", 
                "57", "64", "56", "59", "66", "65", "55", "38", "36", "37"
            ]
        }
    ],
    
    // Группа 2: Роллы (оставшиеся) + Теплые роллы + Роллы без риса + Круассаны + Сладкие роллы (30 товаров)
    [
        {
            title: "Роллы (продолжение)",
            productIds: ["41", "35", "42", "44", "45", "43", "40", "39", "34"]
        },
        {
            title: "Теплые роллы",
            productIds: ["24", "26", "33", "28", "25", "27", "29", "30", "23", "31", "32"]
        },
        {
            title: "Роллы без риса",
            productIds: ["136", "134", "135"]
        },
        {
            title: "Круассаны",
            productIds: ["93", "94", "92"]
        },
        {
            title: "Сладкие роллы",
            productIds: ["150", "139", "137", "138"]
        }
    ],
    
    // Группа 3: Классические роллы + Темпура роллы (15 товаров)
    [
        {
            title: "Классические роллы",
            productIds: ["131", "130", "127", "133", "129", "128", "132"]
        },
        {
            title: "Темпура роллы",
            productIds: ["19", "17", "15", "21", "20", "18", "16", "22"]
        }
    ],
    
    // Группа 4: Суши и гунканы + Теплые сеты (28 товаров)
    [
        {
            title: "Суши и гунканы",
            productIds: [
                "85", "86", "81", "82", "91", "78", "84", "80", "79", "83", 
                "77", "75", "73", "76", "74", "89", "88", "87", "90"
            ]
        },
        {
            title: "Теплые сеты",
            productIds: ["6", "3", "4", "1", "2", "5"]
        }
    ],
    
    // Группа 5: Сеты (24 товара)
    [
        {
            title: "Сеты",
            productIds: [
                "109", "117", "123", "111", "112", "105", "103", "113", "118", 
                "106", "119", "124", "121", "108", "110", "116", "125", "114", 
                "104", "107", "122", "126", "120", "115"
            ]
        }
    ],
    
    // Группа 6: Салаты + Напитки + Дополнительно (26 товаров)
    [
        {
            title: "Салаты",
            productIds: ["98", "96", "95", "97", "99", "102", "101", "100"]
        },
        {
            title: "Напитки",
            productIds: ["13", "9", "8", "10", "12", "14", "7", "11"]
        },
        {
            title: "Дополнительно",
            productIds: ["142", "141", "144", "140", "143", "147", "148", "149", "146", "145"]
        }
    ]
];

// ЗАМЕНИТЕ ФУНКЦИЮ sendCatalog НА ЭТУ:
async function sendCatalog(phone_no_id, from) {
    console.log("=== ОТПРАВКА ОПТИМИЗИРОВАННОГО КАТАЛОГА ===");
    
    try {
        // Получаем CATALOG_ID из переменных окружения
        const catalogId = process.env.CATALOG_ID;
        if (!catalogId) {
            console.error("❌ CATALOG_ID не найден в переменных окружения");
            throw new Error("CATALOG_ID не настроен");
        }
        
        // Отправляем приветственное сообщение
        const welcomeText = "🍣 Добро пожаловать в Yaposhkin Rolls!\n\nСейчас отправлю вам наш каталог. Выберите понравившиеся блюда! ❤️";
        await sendMessage(phone_no_id, from, welcomeText);
        
        // Используем оптимизированные группы (из вашего кода)
        const categoryGroups = optimizedMenuGroups;
        
        // Отправляем каждую группу как отдельный product_list
        for (let i = 0; i < categoryGroups.length; i++) {
            const group = categoryGroups[i];
            await sendProductListWithSections(phone_no_id, from, group, i + 1, categoryGroups.length, catalogId);
        }
        
        // Отправляем финальное сообщение
        const finalText = `Выберите понравившиеся блюда из любой категории и добавьте в корзину.`;
        await sendMessage(phone_no_id, from, finalText);
        
        // ВАЖНО: Устанавливаем состояние ожидания заказа из каталога
        setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER, 1800000); // 30 минут на выбор товаров
        
        console.log("✅ Оптимизированный каталог отправлен полностью");
        
    } catch (error) {
        console.error("❌ Ошибка отправки каталога:", error);
        
        // Fallback - отправляем обычный каталог
        console.log("🔄 Отправляем обычный каталог как fallback");
        const fallbackCatalogData = {
            messaging_product: "whatsapp",
            to: from,
            type: "interactive",
            interactive: {
                type: "catalog_message",
                body: {
                    text: "🍣 Наш полный каталог Yaposhkin Rolls!\n\nВыберите понравившиеся блюда и добавьте в корзину. Все товары свежие и готовятся с любовью! ❤️"
                },
                footer: {
                    text: "Доставка 30-40 минут"
                },
                action: {
                    name: "catalog_message"
                }
            }
        };
        
        await sendWhatsAppMessage(phone_no_id, fallbackCatalogData);
        
        // ВАЖНО: Устанавливаем состояние ожидания заказа из каталога даже для fallback
        setUserWaitingState(from, WAITING_STATES.CATALOG_ORDER, 1800000); // 30 минут на выбор товаров
    }
}

// ОБНОВИТЕ ФУНКЦИЮ sendProductListWithSections для лучших заголовков:
async function sendProductListWithSections(phone_no_id, to, categories, groupNumber, totalGroups, catalogId) {
    try {
        // Формируем секции для WhatsApp
        const sections = categories.map(category => ({
            title: category.title,
            product_items: category.productIds.map(id => ({
                product_retailer_id: id
            }))
        }));
        
        // Подсчитываем общее количество товаров
        const totalProducts = categories.reduce((sum, cat) => sum + cat.productIds.length, 0);
        
        // Формируем умный заголовок
        let headerText;
        if (categories.length === 1) {
            // Одна категория
            headerText = `🍣 ${categories[0].title}`;
        } else if (categories.length === 2) {
            // Две категории
            headerText = `🍣 ${categories[0].title} и ${categories[1].title}`;
        } else if (categories.length === 3) {
            // Три категории
            headerText = `🍣 ${categories[0].title}, ${categories[1].title} и ${categories[2].title}`;
        } else {
            // Много категорий - показываем первые две и количество остальных
            const remaining = categories.length - 2;
            headerText = `🍣 ${categories[0].title}, ${categories[1].title} +${remaining} категорий`;
        }
        
        // Ограничиваем длину заголовка (WhatsApp имеет лимиты)
        if (headerText.length > 60) {
            headerText = `${categories.length} категорий (${totalProducts} товаров)`;
        }
        
        const productListData = {
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
                    // text: `${totalProducts} товаров\nВыберите блюда:`
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
        const categoryNames = categories.map(cat => cat.title).join(', ');
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
            body: text
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
        const message = formatOrderStatusMessage(orderId, status, orderType, locationTitle, estimatedTime, additionalInfo);

        // Отправляем сообщение
        const response = await sendMessage(phone_no_id, customerPhone, message);

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
function formatOrderStatusMessage(orderId, status, orderType, locationTitle, estimatedTime, additionalInfo) {
    const emoji = getStatusEmoji(status);
    const statusText = getStatusText(status);
    
    let message = `${emoji} ${statusText}\n\n`;
    message += `📋 Заказ №${orderId}\n`;

    switch (status.toLowerCase()) {
        case 'confirmed':
        case 'подтвержден':
            message += `✅ Ваш заказ подтвержден и принят в работу!\n\n`;
            if (orderType === 'delivery') {
                message += `🚗 Тип: Доставка\n`;
                if (estimatedTime) {
                    message += `⏰ Ожидаемое время доставки: ${estimatedTime}\n`;
                }
            } else {
                message += `🏪 Тип: Самовывоз\n`;
                if (locationTitle) {
                    message += `📍 Филиал: ${locationTitle}\n`;
                }
                if (estimatedTime) {
                    message += `⏰ Ожидаемое время готовности: ${estimatedTime}\n`;
                }
            }
            message += `\n📞 Если у вас есть вопросы, свяжитесь с нами.`;
            break;

        case 'preparing':
        case 'готовится':
            message += `👨‍🍳 Наши повара готовят ваш заказ!\n\n`;
            if (estimatedTime) {
                message += `⏰ Ожидаемое время готовности: ${estimatedTime}\n\n`;
            }
            message += `🍣 Мы используем только свежие ингредиенты и готовим с любовью!`;
            break;

        case 'ready':
        case 'готов':
            if (orderType === 'delivery') {
                message += `🚗 Ваш заказ готов и передан курьеру!\n\n`;
                message += `📍 Курьер уже в пути к вам.\n`;
                if (estimatedTime) {
                    message += `⏰ Ожидаемое время доставки: ${estimatedTime}\n`;
                }
                message += `\n📞 Курьер свяжется с вами перед прибытием.`;
            } else {
                message += `🎉 Ваш заказ готов к выдаче!\n\n`;
                if (locationTitle) {
                    message += `📍 Филиал: ${locationTitle}\n`;
                }
                message += `🏪 Приезжайте за заказом в удобное для вас время.\n`;
                message += `\n💳 Оплата при получении.`;
            }
            break;

        case 'out_for_delivery':
        case 'в_доставке':
            message += `🚗 Курьер в пути!\n\n`;
            message += `📍 Ваш заказ доставляется по указанному адресу.\n`;
            if (estimatedTime) {
                message += `⏰ Ожидаемое время прибытия: ${estimatedTime}\n`;
            }
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
            message += `✅ Заказ выполнен!\n\n`;
            message += `🙏 Спасибо за выбор Yaposhkin Rolls!\n`;
            message += `⭐ Будем рады вашему отзыву о качестве блюд и сервисе.\n`;
            message += `\n🍣 Ждем вас снова!`;
            break;

        case 'cancelled':
        case 'отменен':
            message += `❌ Заказ отменен\n\n`;
            if (additionalInfo) {
                message += `📝 Причина: ${additionalInfo}\n\n`;
            }
            message += `😔 Приносим извинения за неудобства.\n`;
            message += `📞 Если у вас есть вопросы, свяжитесь с нами.\n`;
            message += `\n🍣 Будем рады видеть вас снова!`;
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

    return message;
}

// Функция получения эмодзи для статуса
function getStatusEmoji(status) {
    const emojiMap = {
        'confirmed': '✅',
        'подтвержден': '✅',
        'preparing': '👨‍🍳',
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
        'confirmed': 'Заказ подтвержден',
        'подтвержден': 'Заказ подтвержден',
        'preparing': 'Заказ готовится',
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

app.get("/", (req, res) => {
    res.status(200).send("hello this is webhook setup");
});