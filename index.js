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

            try {
                // Проверяем тип сообщения
                if (message.type === "location") {
                    // Пользователь отправил местоположение
                    console.log("📍 Обрабатываем местоположение");
                    await handleLocationMessage(phone_no_id, from, message);
                } else if (message.type === "interactive") {
                    console.log("Interactive message type:", message.interactive.type);
                    
                    if (message.interactive.type === "nfm_reply") {
                        // Ответ от Flow
                        console.log("🔄 Обрабатываем ответ от Flow");
                        await handleFlowResponse(phone_no_id, from, message, body_param);
                    } else if (message.interactive.type === "product_list_reply") {
                        // Ответ от каталога - обрабатываем заказ
                        console.log("🛒 Обрабатываем ответ от каталога (product_list)");
                        await handleCatalogResponse(phone_no_id, from, message);
                    } else if (message.interactive.type === "button_reply") {
                        // Ответ от кнопки
                        console.log("🔘 Обрабатываем ответ от кнопки");
                        await handleButtonResponse(phone_no_id, from, message);
                    } else {
                        console.log("❓ Неизвестный тип interactive сообщения:", message.interactive.type);
                        await handleIncomingMessage(phone_no_id, from, message);
                    }
                } else if (message.type === "order") {
                    // Ответ от каталога в формате order
                    console.log("🛒 Обрабатываем ответ от каталога (order)");
                    await handleCatalogOrderResponse(phone_no_id, from, message);
                } else {
                    // Любое другое сообщение - проверяем клиента и отправляем Flow
                    console.log("📝 Обрабатываем обычное сообщение");
                    await handleIncomingMessage(phone_no_id, from, message);
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

// Обработка местоположения
async function handleLocationMessage(phone_no_id, from, message) {
    try {
        console.log("=== ОБРАБОТКА МЕСТОПОЛОЖЕНИЯ ===");
        
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
        
        // Очищаем состояние
        userStates.delete(from);
        
    } catch (error) {
        console.error("❌ Ошибка обработки местоположения:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при сохранении адреса. Попробуйте еще раз.");
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
        
        // Отправляем подтверждение
        if (userState.flow_type === 'new_customer') {
            const confirmText = `Спасибо за регистрацию, ${userState.customer_name}! 🎉\n\nВаш адрес сохранен: ${userState.delivery_address}\n\nТеперь вы можете делать заказы. Сейчас отправлю вам наш каталог! 🍣`;
            await sendMessage(phone_no_id, from, confirmText);
        } else {
            const confirmText = `✅ Новый адрес добавлен!\n\n📍 ${userState.delivery_address}\n\nТеперь выберите блюда из каталога:`;
            await sendMessage(phone_no_id, from, confirmText);
        }
        
        // Отправляем каталог через 2 секунды
        setTimeout(async () => {
            await sendCatalog(phone_no_id, from);
        }, 2000);
        
    } catch (error) {
        console.error("❌ Ошибка обновления клиента:", error);
        
        let errorMessage = "Произошла ошибка при сохранении данных.";
        if (error.response?.status === 400) {
            errorMessage = "Некорректные данные. Попробуйте еще раз.";
        } else if (error.response?.status === 404) {
            errorMessage = "Клиент не найден. Попробуйте зарегистрироваться заново.";
        }
        
        await sendMessage(phone_no_id, from, errorMessage);
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

// Отправка Flow для существующих клиентов
async function sendExistingCustomerFlow(phone_no_id, from, customer, branches) {
    console.log("=== ОТПРАВКА FLOW ДЛЯ СУЩЕСТВУЮЩИХ КЛИЕНТОВ ===");
    
    // Формируем массив адресов в формате объектов для dropdown
    const addresses = customer.addresses.map((addr, index) => ({
        id: `address_${index}`,
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
            await sendMessage(phone_no_id, from, "Спасибо! Выберите блюда из каталога:");
            
            setTimeout(async () => {
                await sendCatalog(phone_no_id, from);
            }, 1000);
        }

    } catch (error) {
        console.error("Ошибка обработки Flow ответа:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при обработке формы. Попробуйте еще раз.");
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

            // Отправляем запрос местоположения
            await sendLocationRequest(phone_no_id, from, data.customer_name);
        } else {
            // Самовывоз - сразу регистрируем и отправляем каталог
            await registerCustomerWithoutLocation(phone_no_id, from, data);
        }

    } catch (error) {
        console.error('❌ Ошибка регистрации:', error);
        await sendMessage(phone_no_id, from, 'Извините, произошла ошибка при регистрации. Попробуйте позже.');
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
        
        // Отправляем каталог через 2 секунды
        setTimeout(async () => {
            await sendCatalog(phone_no_id, from);
        }, 2000);
        
    } catch (error) {
        console.error("❌ Ошибка регистрации без местоположения:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при регистрации. Попробуйте еще раз.");
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
            
            // Обновляем состояние для запроса местоположения
            userStates.set(from, {
                flow_type: 'existing_customer',
                customer_name: data.customer_name || 'Клиент',
                delivery_address: data.new_address
            });
            
            // Отправляем запрос местоположения
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
            
            // Отправляем каталог через 1 секунду
            setTimeout(async () => {
                await sendCatalog(phone_no_id, from);
            }, 1000);
        }
        
    } catch (error) {
        console.error('❌ Ошибка обработки заказа:', error);
        await sendMessage(phone_no_id, from, 'Извините, произошла ошибка. Попробуйте еще раз.');
    }
}

// Отправка запроса местоположения
async function sendLocationRequest(phone_no_id, from, customerName) {
    console.log("=== ЗАПРОС МЕСТОПОЛОЖЕНИЯ ===");
    
    const locationText = `Спасибо, ${customerName}! 📍\n\nДля точной доставки, пожалуйста, поделитесь своим местоположением.\n\nНажмите на скрепку 📎 → Местоположение 📍 → Отправить текущее местоположение`;
    
    await sendMessage(phone_no_id, from, locationText);
}

// Обработка ответа от каталога в формате order
async function handleCatalogOrderResponse(phone_no_id, from, message) {
    try {
        console.log("=== ОТВЕТ ОТ КАТАЛОГА (ORDER FORMAT) ===");
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
                const itemPrice = parseFloat(item.item_price) || 0;
                const itemTotal = itemPrice * item.quantity;
                
                console.log(`Название товара: ${productName}`);
                
                orderSummary += `${index + 1}. ${productName}\n`;
                orderSummary += `Количество: ${item.quantity} ${productInfo.measure_unit || 'шт'}\n`;
                orderSummary += `Цена: ${itemPrice} KGS x ${item.quantity} = ${itemTotal} KGS\n\n`;
                
                totalAmount += itemTotal;
                
                // Сохраняем для заказа
                orderItems.push({
                    id: parseInt(item.product_retailer_id),
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
    }
}

// Расчет доставки и оформление заказа
async function calculateDeliveryAndSubmitOrder(phone_no_id, from, orderItems, totalAmount, orderSummary, userState) {
    try {
        console.log("=== РАСЧЕТ ДОСТАВКИ И ОФОРМЛЕНИЕ ЗАКАЗА ===");
        
        // Получаем данные клиента
        const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
        const customerData = customerResponse.data;
        
        let deliveryCost = 0;
        let locationId = null;
        let locationTitle = "";
        let orderType = "pickup"; // По умолчанию самовывоз
        let deliveryAddress = "";
        
        // Определяем тип заказа и рассчитываем доставку
        if (userState && userState.order_type === 'delivery') {
            console.log("🚚 Обрабатываем доставку");
            orderType = "delivery";
            
            let address = null;
            
            // Определяем адрес
            if (userState.delivery_choice === 'new') {
                // Новый адрес - ищем в последних добавленных
                const addresses = customerData.customer.addresses || [];
                address = addresses[addresses.length - 1]; // Последний добавленный
                deliveryAddress = userState.new_address || address?.full_address || "";
            } else {
                // Существующий адрес
                const addressIndex = parseInt(userState.delivery_choice.replace('address_', ''));
                // address = customerData.customer.addresses?.[addressIndex];
                address = customerData.customer.addresses.map((item) => (item.locationId == addressIndex));
                deliveryAddress = address?.full_address || "";
                console.log(`This is address index ${[addressIndex]}`);

                console.log(`This is address ${address}`);
            }
            
            // Если есть координаты - рассчитываем доставку
            if (address?.geocoding?.latitude && address?.geocoding?.longitude) {
                const lat = address.geocoding.latitude;
                const lon = address.geocoding.longitude;
                
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
                        // Доставка недоступна - переключаемся на самовывоз
                        orderType = "pickup";
                        await sendMessage(phone_no_id, from, "❌ К сожалению, доставка по этому адресу недоступна. Переключаемся на самовывоз.");
                    }
                } catch (deliveryError) {
                    console.error("❌ Ошибка запроса доставки:", deliveryError);
                    orderType = "pickup";
                    await sendMessage(phone_no_id, from, "❌ Ошибка расчета доставки. Переключаемся на самовывоз.");
                }
            } else {
                // Нет координат - самовывоз
                orderType = "pickup";
                await sendMessage(phone_no_id, from, "❌ Нет координат адреса. Переключаемся на самовывоз.");
            }
        }
        
        // Если самовывоз - выбираем филиал
        if (orderType === "pickup") {
            console.log("🏪 Обрабатываем самовывоз");
            
            if (userState?.branch) {
                // Филиал выбран в Flow
                const branchInfo = await getBranchInfo(userState.branch);
                if (branchInfo) {
                    locationId = parseInt(userState.branch);
                    locationTitle = branchInfo.title;
                }
            } else {
                // Выбираем первый доступный филиал
                const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
                const restaurants = restaurantsResponse.data;
                
                if (restaurants.length > 0) {
                    const selectedBranch = restaurants[0];
                    locationId = selectedBranch.external_id;
                    locationTitle = selectedBranch.title;
                }
            }
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
        
        // Очищаем состояние
        userStates.delete(from);
        
    } catch (error) {
        console.error("❌ Ошибка расчета доставки и оформления заказа:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при оформлении заказа. Наш менеджер свяжется с вами.");
        userStates.delete(from);
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
                firstName: "Тест",
                comment: "Не реальный заказ",
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
        
        // Отправляем сообщение об успехе
        await sendOrderSuccessMessage(phone_no_id, from, preorderResponse.data, orderType, finalAmount, locationTitle);

    } catch (error) {
        console.error('❌ Ошибка отправки заказа в API:', error);
        
        let errorMessage = 'Извините, произошла ошибка при оформлении заказа.';
        
        if (error.response?.status === 400) {
            errorMessage += ' Проверьте корректность данных.';
        } else if (error.response?.status === 404) {
            errorMessage += ' Ресторан временно недоступен.';
        }
        
        errorMessage += ' Наш менеджер свяжется с вами.';
        
        await sendMessage(phone_no_id, from, errorMessage);
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
        
    } catch (error) {
        console.error("Ошибка обработки ответа каталога:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при обработке заказа. Попробуйте еще раз.");
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

// Отправка каталога
async function sendCatalog(phone_no_id, to) {
    console.log("=== ОТПРАВКА КАТАЛОГА ===");
    
    const catalogData = {
        messaging_product: "whatsapp",
        to: to,
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

    await sendWhatsAppMessage(phone_no_id, catalogData);
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

app.get("/", (req, res) => {
    res.status(200).send("hello this is webhook setup");
});