const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const app = express().use(bodyParser.json());

const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN;

// Конфигурация
const TEMIR_API_BASE = 'https://ya.temir.me';

// Flow IDs
const NEW_CUSTOMER_FLOW_ID = '4265839023734503';
const ORDER_FLOW_ID = '708820881926236';

// Состояния пользователей
const userStates = new Map();

app.listen(PORT, () => {
    console.log("webhook is listening");
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});

// Верификация webhook
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const challenge = req.query["hub.challenge"];
    const token = req.query["hub.verify_token"];

    if (mode && token) {
        if (mode === "subscribe" && token === mytoken) {
            res.status(200).send(challenge);
        } else {
            res.status(403).send("Forbidden");
        }
    }
});

app.post("/webhook", async (req, res) => {
    const bodyParam = req.body;

    console.log("=== ПОЛУЧЕННОЕ СООБЩЕНИЕ ===");
    console.log(JSON.stringify(bodyParam, null, 2));

    if (bodyParam.object) {
        console.log("inside body param");
        if (bodyParam.entry && 
            bodyParam.entry[0].changes && 
            bodyParam.entry[0].changes[0].value.messages && 
            bodyParam.entry[0].changes[0].value.messages[0]) {
            
            const phoneNoId = bodyParam.entry[0].changes[0].value.metadata.phone_number_id;
            const from = bodyParam.entry[0].changes[0].value.messages[0].from;
            const message = bodyParam.entry[0].changes[0].value.messages[0];

            console.log("phone number " + phoneNoId);
            console.log("from " + from);
            console.log("message type:", message.type);
            console.log("message:", JSON.stringify(message, null, 2));

            try {
                // Проверяем тип сообщения
                if (message.type === "location") {
                    console.log("📍 Обрабатываем местоположение");
                    await handleLocationMessage(phoneNoId, from, message);
                } else if (message.type === "interactive") {
                    console.log("Interactive message type:", message.interactive.type);
                    
                    if (message.interactive.type === "nfm_reply") {
                        console.log("🔄 Обрабатываем ответ от Flow");
                        await handleFlowResponse(phoneNoId, from, message, bodyParam);
                    } else if (message.interactive.type === "product_list_reply") {
                        console.log("🛒 Обрабатываем ответ от каталога (product_list)");
                        await handleCatalogResponse(phoneNoId, from, message);
                    } else if (message.interactive.type === "button_reply") {
                        console.log("🔘 Обрабатываем ответ от кнопки");
                        await handleButtonResponse(phoneNoId, from, message);
                    } else {
                        console.log("❓ Неизвестный тип interactive сообщения:", message.interactive.type);
                        await handleIncomingMessage(phoneNoId, from, message);
                    }
                } else if (message.type === "order") {
                    console.log("🛒 Обрабатываем ответ от каталога (order)");
                    await handleCatalogOrderResponse(phoneNoId, from, message);
                } else {
                    console.log("📝 Обрабатываем обычное сообщение");
                    await handleIncomingMessage(phoneNoId, from, message);
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
async function handleLocationMessage(phoneNoId, from, message) {
    try {
        console.log("=== ОБРАБОТКА МЕСТОПОЛОЖЕНИЯ ===");
        
        const location = message.location;
        const longitude = location.longitude;
        const latitude = location.latitude;
        
        console.log(`📍 Получено местоположение: ${latitude}, ${longitude}`);
        
        const userState = userStates.get(from);
        
        if (!userState) {
            console.log("❌ Состояние пользователя не найдено");
            await sendMessage(phoneNoId, from, "Произошла ошибка. Попробуйте заново оформить заказ.");
            return;
        }
        
        console.log("👤 Состояние пользователя:", userState);
        
        await updateCustomerWithLocation(phoneNoId, from, userState, longitude, latitude);
        
    } catch (error) {
        console.error("❌ Ошибка обработки местоположения:", error);
        await sendMessage(phoneNoId, from, "Произошла ошибка при сохранении адреса. Попробуйте еще раз.");
        userStates.delete(from);
    }
}

// Обновление клиента с местоположением
async function updateCustomerWithLocation(phoneNoId, from, userState, longitude, latitude) {
    try {
        console.log("=== ОБНОВЛЕНИЕ КЛИЕНТА С МЕСТОПОЛОЖЕНИЕМ ===");
        
        const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
        const qrToken = customerResponse.data.qr_access_token;
        
        console.log("🔑 QR Token:", qrToken);
        
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
        
        const updateResponse = await axios.post(
            `${TEMIR_API_BASE}/qr/update-customer/?qr_token=${qrToken}`,
            updateData
        );
        
        console.log("✅ Клиент успешно обновлен:", updateResponse.data);
        
        // Обновляем состояние пользователя с правильными данными для заказа
        if (userState.flow_type === 'new_customer') {
            userStates.set(from, {
                flow_type: 'new_customer',
                order_type: 'delivery',
                delivery_choice: 'new',
                customer_name: userState.customer_name,
                delivery_address: userState.delivery_address
            });
            
            const confirmText = `Спасибо за регистрацию, ${userState.customer_name}! 🎉\n\nВаш адрес сохранен: ${userState.delivery_address}\n\nТеперь вы можете делать заказы. Сейчас отправлю вам наш каталог! 🍣`;
            await sendMessage(phoneNoId, from, confirmText);
        } else {
            userStates.set(from, {
                flow_type: 'existing_customer',
                order_type: 'delivery',
                delivery_choice: 'new',
                customer_name: userState.customer_name,
                delivery_address: userState.delivery_address
            });
            
            const confirmText = `✅ Новый адрес добавлен!\n\n📍 ${userState.delivery_address}\n\nТеперь выберите блюда из каталога:`;
            await sendMessage(phoneNoId, from, confirmText);
        }
        
        setTimeout(async () => {
            await sendCatalog(phoneNoId, from);
        }, 2000);
        
    } catch (error) {
        console.error("❌ Ошибка обновления клиента:", error);
        
        let errorMessage = "Произошла ошибка при сохранении данных.";
        if (error.response?.status === 400) {
            errorMessage = "Некорректные данные. Попробуйте еще раз.";
        } else if (error.response?.status === 404) {
            errorMessage = "Клиент не найден. Попробуйте зарегистрироваться заново.";
        }
        
        await sendMessage(phoneNoId, from, errorMessage);
        userStates.delete(from);
    }
}

// Обработка входящих сообщений
async function handleIncomingMessage(phoneNoId, from, message) {
    console.log("=== ПРОВЕРКА КЛИЕНТА ===");
    
    const messageText = message.text?.body?.toLowerCase();
    console.log(`Получено сообщение от ${from}: ${messageText || 'не текст'}`);
    
    await checkCustomerAndSendFlow(phoneNoId, from);
}

// Проверка клиента и отправка соответствующего Flow
async function checkCustomerAndSendFlow(phoneNoId, from) {
    try {
        console.log(`🔍 Проверяем клиента: ${from}`);
        
        const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
        const restaurants = restaurantsResponse.data;
        
        const branches = restaurants.map(restaurant => ({
            id: restaurant.external_id.toString(),
            title: `🏪 ${restaurant.title}`
        }));
        
        console.log("🏪 Филиалы для Flow:", branches);
        
        const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
        const customerData = customerResponse.data;
        
        console.log('👤 Данные клиента:', customerData);

        const hasAddresses = customerData.customer.addresses && customerData.customer.addresses.length > 0;
        const isNewCustomer = !hasAddresses || 
                             !customerData.customer.first_name || 
                             customerData.customer.first_name === 'Имя';

        if (isNewCustomer) {
            console.log('🆕 Новый клиент - отправляем регистрационный Flow');
            await sendNewCustomerFlow(phoneNoId, from, branches);
        } else {
            console.log('✅ Существующий клиент - отправляем Flow с адресами');
            await sendExistingCustomerFlow(phoneNoId, from, customerData.customer, branches);
        }

    } catch (error) {
        console.error('❌ Ошибка проверки клиента:', error);
        
        try {
            const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
            const restaurants = restaurantsResponse.data;
            const branches = restaurants.map(restaurant => ({
                id: restaurant.external_id.toString(),
                title: `🏪 ${restaurant.title}`
            }));
            
            console.log('🆕 Ошибка API - отправляем регистрационный Flow');
            await sendNewCustomerFlow(phoneNoId, from, branches);
        } catch (fallbackError) {
            console.error('❌ Критическая ошибка получения филиалов:', fallbackError);
            await sendMessage(phoneNoId, from, "Извините, временные технические проблемы. Попробуйте позже.");
        }
    }
}

// Отправка Flow для новых клиентов
async function sendNewCustomerFlow(phoneNoId, from, branches) {
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

    await sendWhatsAppMessage(phoneNoId, flowData);
}

// Отправка Flow для существующих клиентов
async function sendExistingCustomerFlow(phoneNoId, from, customer, branches) {
    console.log("=== ОТПРАВКА FLOW ДЛЯ СУЩЕСТВУЮЩИХ КЛИЕНТОВ ===");
    
    const addresses = customer.addresses.map((addr) => ({
        id: `address_${addr.id}`,
        title: addr.full_address
    }));
    
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

    await sendWhatsAppMessage(phoneNoId, flowData);
}

// Обработка ответов Flow
async function handleFlowResponse(phoneNoId, from, message, bodyParam) {
    try {
        console.log("=== ОБРАБОТКА FLOW ОТВЕТА ===");
        
        const flowResponse = JSON.parse(message.interactive.nfm_reply.response_json);
        const customerProfile = bodyParam.entry[0].changes[0].value.contacts[0].profile.name;
        
        console.log('Телефон клиента:', from);
        console.log('Имя профиля WhatsApp:', customerProfile);
        console.log('Данные из Flow:', flowResponse);

        if (flowResponse.flow_type === 'new_customer') {
            await handleNewCustomerRegistration(phoneNoId, from, flowResponse);
        } else if (flowResponse.flow_type === 'existing_customer') {
            await handleExistingCustomerOrder(phoneNoId, from, flowResponse);
        } else {
            console.log("❓ Неизвестный тип Flow, отправляем каталог");
            await sendMessage(phoneNoId, from, "Спасибо! Выберите блюда из каталога:");
            
            setTimeout(async () => {
                await sendCatalog(phoneNoId, from);
            }, 1000);
        }

    } catch (error) {
        console.error("Ошибка обработки Flow ответа:", error);
        await sendMessage(phoneNoId, from, "Произошла ошибка при обработке формы. Попробуйте еще раз.");
    }
}

// Обработка регистрации нового клиента
async function handleNewCustomerRegistration(phoneNoId, from, data) {
    try {
        console.log('📝 Регистрируем нового клиента:', data);

        if (data.order_type === 'delivery' && data.delivery_address) {
            userStates.set(from, {
                flow_type: 'new_customer',
                customer_name: data.customer_name,
                delivery_address: data.delivery_address
            });

            await sendLocationRequest(phoneNoId, from, data.customer_name);
        } else {
            await registerCustomerWithoutLocation(phoneNoId, from, data);
        }

    } catch (error) {
        console.error('❌ Ошибка регистрации:', error);
        await sendMessage(phoneNoId, from, 'Извините, произошла ошибка при регистрации. Попробуйте позже.');
    }
}

// Регистрация клиента без местоположения (для самовывоза)
async function registerCustomerWithoutLocation(phoneNoId, from, data) {
    try {
        console.log("=== РЕГИСТРАЦИЯ КЛИЕНТА БЕЗ МЕСТОПОЛОЖЕНИЯ ===");
        
        const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
        const qrToken = customerResponse.data.qr_access_token;
        
        const updateData = {
            firstName: data.customer_name
        };
        
        const updateResponse = await axios.post(
            `${TEMIR_API_BASE}/qr/update-customer/?qr_token=${qrToken}`,
            updateData
        );
        
        console.log("✅ Клиент зарегистрирован:", updateResponse.data);
        
        userStates.set(from, {
            flow_type: 'new_customer',
            order_type: 'pickup',
            branch: data.branch,
            customer_name: data.customer_name
        });
        
        const confirmText = `Спасибо за регистрацию, ${data.customer_name}! 🎉\n\nВы выбрали самовывоз.\n\nТеперь выберите блюда из нашего каталога! 🍣`;
        await sendMessage(phoneNoId, from, confirmText);
        
        setTimeout(async () => {
            await sendCatalog(phoneNoId, from);
        }, 2000);
        
    } catch (error) {
        console.error("❌ Ошибка регистрации без местоположения:", error);
        await sendMessage(phoneNoId, from, "Произошла ошибка при регистрации. Попробуйте еще раз.");
    }
}

// Обработка заказа существующего клиента
async function handleExistingCustomerOrder(phoneNoId, from, data) {
    try {
        console.log('🛒 Обрабатываем заказ существующего клиента:', data);
        
        if (data.order_type === 'delivery' && data.delivery_choice === 'new' && data.new_address) {
            console.log('📍 Клиент выбрал доставку с новым адресом:', data.new_address);
            
            userStates.set(from, {
                flow_type: 'existing_customer',
                customer_name: data.customer_name || 'Клиент',
                delivery_address: data.new_address
            });
            
            await sendLocationRequest(phoneNoId, from, data.customer_name);
            
        } else {
            console.log('✅ Клиент выбрал существующий адрес или самовывоз - отправляем каталог');
            
            userStates.set(from, {
                flow_type: 'existing_customer',
                order_type: data.order_type,
                delivery_choice: data.delivery_choice,
                new_address: data.new_address,
                branch: data.branch,
                customer_name: data.customer_name
            });
            
            let confirmText;
            if (data.order_type === 'delivery') {
                confirmText = `✅ Отлично! Заказ будет доставлен по выбранному адресу.\n\nВыберите блюда из каталога:`;
            } else {
                confirmText = `✅ Отлично! Вы выбрали самовывоз.\n\nВыберите блюда из каталога:`;
            }
            
            await sendMessage(phoneNoId, from, confirmText);
            
            setTimeout(async () => {
                await sendCatalog(phoneNoId, from);
            }, 1000);
        }
        
    } catch (error) {
        console.error('❌ Ошибка обработки заказа:', error);
        await sendMessage(phoneNoId, from, 'Извините, произошла ошибка. Попробуйте еще раз.');
    }
}

// Отправка запроса местоположения
async function sendLocationRequest(phoneNoId, from, customerName) {
    console.log("=== ЗАПРОС МЕСТОПОЛОЖЕНИЯ ===");
    
    const locationText = `Спасибо, ${customerName}! 📍\n\nДля точной доставки, пожалуйста, поделитесь своим местоположением.\n\nНажмите на скрепку 📎 → Местоположение 📍 → Отправить текущее местоположение`;
    
    await sendMessage(phoneNoId, from, locationText);
}

// Обработка ответа от каталога в формате order
async function handleCatalogOrderResponse(phoneNoId, from, message) {
    try {
        console.log("=== ОТВЕТ ОТ КАТАЛОГА (ORDER FORMAT) ===");
        console.log("Order message:", JSON.stringify(message, null, 2));
        
        const order = message.order;
        
        let orderSummary = "🛒 Ваш заказ:\n\n";
        let totalAmount = 0;
        const orderItems = [];
        
        if (order && order.product_items) {
            console.log("=== ДЕТАЛИ ТОВАРОВ ===");
            
            for (let index = 0; index < order.product_items.length; index++) {
                const item = order.product_items[index];
                console.log(`Товар ${index + 1}:`, JSON.stringify(item, null, 2));
                
                const productInfo = await getProductInfo(item.product_retailer_id);
                
                const productName = productInfo.title || `Товар ${item.product_retailer_id}`;
                const itemPrice = parseFloat(item.item_price) || 0;
                const itemTotal = itemPrice * item.quantity;
                
                console.log(`Название товара: ${productName}`);
                
                orderSummary += `${index + 1}. ${productName}\n`;
                orderSummary += `Количество: ${item.quantity} ${productInfo.measure_unit || 'шт'}\n`;
                orderSummary += `Цена: ${itemPrice} KGS x ${item.quantity} = ${itemTotal} KGS\n\n`;
                
                totalAmount += itemTotal;
                
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
        
        const userState = userStates.get(from);
        
        await calculateDeliveryAndSubmitOrder(phoneNoId, from, orderItems, totalAmount, orderSummary, userState);
        
    } catch (error) {
        console.error("Ошибка обработки order ответа каталога:", error);
        await sendMessage(phoneNoId, from, "Произошла ошибка при обработке заказа. Попробуйте еще раз.");
    }
}

// Расчет доставки и оформление заказа
async function calculateDeliveryAndSubmitOrder(phoneNoId, from, orderItems, totalAmount, orderSummary, userState) {
    try {
        console.log("=== РАСЧЕТ ДОСТАВКИ И ОФОРМЛЕНИЕ ЗАКАЗА ===");
        
        const customerResponse = await axios.get(`${TEMIR_API_BASE}/qr/customer/?phone=${from}`);
        const customerData = customerResponse.data;
        
        let deliveryCost = 0;
        let locationId = null;
        let locationTitle = "";
        let orderType = "pickup";
        let deliveryAddress = "";

        console.log(`type order is ${userState?.order_type}`);
        console.log(`userState is`, userState);
        
        if (userState && userState.order_type === 'delivery') {
            console.log("🚚 Обрабатываем доставку");
            orderType = "delivery";
            
            let address = null;
            let tempLat = null;
            let tempLon = null;
            
            if (userState.delivery_choice === 'new') {
                const addresses = customerData.customer.addresses || [];
                address = addresses[addresses.length - 1];
                deliveryAddress = userState.delivery_address || address?.full_address || "";
                console.log(`This is address ${address}`);
                
                if (address?.geocoding_json) {
                    console.log(`This is address latitude ${address.geocoding_json.latitude}`);
                    tempLat = address.geocoding_json.latitude;
                    console.log(`This is address longitude ${address.geocoding_json.longitude}`);
                    tempLon = address.geocoding_json.longitude;
                }
            } else {
                const addressIndex = parseInt(userState.delivery_choice.replace('address_', ''));
                address = customerData.customer.addresses.find(item => item.id == addressIndex);
                deliveryAddress = address?.full_address || "";
                console.log(`This is address index ${addressIndex}`);
                console.log(`This is addresses`, customerData.customer.addresses);
                console.log(`This is address`, address);
                
                if (address?.geocoding_json) {
                    console.log(`This is address latitude ${address.geocoding_json.latitude}`);
                    tempLat = address.geocoding_json.latitude;
                    console.log(`This is address longitude ${address.geocoding_json.longitude}`);
                    tempLon = address.geocoding_json.longitude;
                }
            }
            
            if (!tempLat || !tempLon) {
                console.log("❌ Нет координат адреса для доставки");
                await sendMessage(phoneNoId, from, "❌ Ошибка: не удается определить координаты адреса доставки. Попробуйте указать адрес заново или обратитесь к менеджеру.");
                userStates.delete(from);
                return;
            }
            
            const lat = tempLat;
            const lon = tempLon;
            
            console.log(`📍 Координаты доставки: ${lat}, ${lon}`);
            
            try {
                const deliveryResponse = await axios.get(
                    `${TEMIR_API_BASE}/qr/delivery/?lat=${lat}&lon=${lon}`
                );
                
                console.log("🚚 Ответ delivery API:", deliveryResponse.data);
                
                if (deliveryResponse.data && Array.isArray(deliveryResponse.data) && deliveryResponse.data.length > 0) {
                    const deliveryInfo = deliveryResponse.data[0];
                    deliveryCost = deliveryInfo.delivery_cost || 0;
                    locationId = deliveryInfo.restaurant_id;
                    locationTitle = deliveryInfo.title || "Ресторан";
                    
                    console.log(`✅ Доставка доступна: ${deliveryCost} KGS, филиал: ${locationTitle}`);
                } else {
                    console.log("❌ Адрес вне зоны доставки (пустой ответ API)");
                    
                    let errorMessage = "❌ К сожалению, ваш адрес находится вне зоны доставки.\n\n";
                    errorMessage += `📍 Адрес: ${deliveryAddress}\n\n`;
                    errorMessage += "Вы можете:\n";
                    errorMessage += "• Указать другой адрес в зоне доставки\n";
                    errorMessage += "• Выбрать самовывоз из наших филиалов\n";
                    errorMessage += "• Обратиться к менеджеру для уточнения зон доставки\n\n";
                    errorMessage += "Для самовывоза напишите любое сообщение и выберите 'Самовывоз'.";
                                        await sendMessage(phoneNoId, from, errorMessage);
                    userStates.delete(from);
                    return;
                }
            } catch (deliveryError) {
                console.error("❌ Ошибка запроса доставки:", deliveryError);
                await sendMessage(phoneNoId, from, "❌ Произошла ошибка при проверке зоны доставки. Попробуйте позже или обратитесь к менеджеру.");
                userStates.delete(from);
                return;
            }
        } else {
            console.log("🏪 Обрабатываем самовывоз");
            
            if (userState?.branch) {
                const branchInfo = await getBranchInfo(userState.branch);
                if (branchInfo) {
                    locationId = parseInt(userState.branch);
                    locationTitle = branchInfo.title;
                } else {
                    console.log("❌ Информация о выбранном филиале не найдена");
                    await sendMessage(phoneNoId, from, "❌ Ошибка: выбранный филиал недоступен. Попробуйте заново или обратитесь к менеджеру.");
                    userStates.delete(from);
                    return;
                }
            } else {
                try {
                    const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
                    const restaurants = restaurantsResponse.data;
                    
                    if (restaurants.length > 0) {
                        const selectedBranch = restaurants[0];
                        locationId = selectedBranch.external_id;
                        locationTitle = selectedBranch.title;
                    } else {
                        console.log("❌ Нет доступных филиалов");
                        await sendMessage(phoneNoId, from, "❌ Извините, в данный момент нет доступных филиалов для самовывоза. Обратитесь к менеджеру.");
                        userStates.delete(from);
                        return;
                    }
                } catch (error) {
                    console.error("❌ Ошибка получения списка филиалов:", error);
                    await sendMessage(phoneNoId, from, "❌ Ошибка получения информации о филиалах. Попробуйте позже или обратитесь к менеджеру.");
                    userStates.delete(from);
                    return;
                }
            }
        }
        
        if (!locationId) {
            console.log("❌ Не удалось определить локацию для заказа");
            await sendMessage(phoneNoId, from, "❌ Ошибка определения места выполнения заказа. Обратитесь к менеджеру.");
            userStates.delete(from);
            return;
        }
        
        const finalAmount = totalAmount + deliveryCost;
        
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
        
        await sendMessage(phoneNoId, from, costMessage);
        
        await submitOrder(phoneNoId, from, orderItems, customerData, locationId, locationTitle, orderType, finalAmount);
        
        userStates.delete(from);
        
    } catch (error) {
        console.error("❌ Ошибка расчета доставки и оформления заказа:", error);
        await sendMessage(phoneNoId, from, "❌ Произошла критическая ошибка при оформлении заказа. Наш менеджер свяжется с вами.");
        userStates.delete(from);
    }
}

// Отправка заказа в API
async function submitOrder(phoneNoId, from, orderItems, customerData, locationId, locationTitle, orderType, finalAmount) {
    try {
        console.log("📝 Отправляем заказ в API");
        
        const preorderData = {
            locationId: parseInt(locationId),
            locationTitle: locationTitle,
            type: orderType,
            customerContact: {
                firstName: "Test",
                comment: "Не реальный заказ",
                contactMethod: {
                    type: "phoneNumber",
                    value: from
                }
            },
            orderDueDateDelta: 0,
            guests: [{
                orderItems: orderItems
            }],
            paymentSumWithDiscount: null
        };
        
        console.log("📝 Данные для preorder:", JSON.stringify(preorderData, null, 2));
        
        const preorderResponse = await axios.post(
            `${TEMIR_API_BASE}/qr/preorder/?qr_token=${customerData.qr_access_token}`,
            preorderData
        );
        
        console.log("✅ Ответ preorder API:", preorderResponse.data);
        
        if (preorderResponse.data.error) {
            console.log("❌ Обнаружена ошибка в ответе API:", preorderResponse.data.error);
            throw {
                response: {
                    status: 200,
                    data: preorderResponse.data
                }
            };
        }
        
        await sendOrderSuccessMessage(phoneNoId, from, preorderResponse.data, orderType, finalAmount, locationTitle);

    } catch (error) {
        console.error('❌ Ошибка отправки заказа в API:', error);
        
        let errorMessage = '';
        
        if (error.response?.data?.error?.description) {
            const errorDescription = error.response.data.error.description;
            
            if (errorDescription.includes("Location is closed")) {
                console.log("🔒 Филиал закрыт");
                
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
                errorMessage = `❌ К сожалению, некоторые товары из вашего заказа сейчас недоступны.\n\n`;
                errorMessage += `Попробуйте выбрать другие блюда из каталога или свяжитесь с нашим менеджером для уточнения наличия.`;
            } else {
                errorMessage = `❌ Ошибка оформления заказа: ${errorDescription}\n\n`;
                errorMessage += `Наш менеджер свяжется с вами для решения проблемы.`;
            }
        } else if (error.response?.data?.error?.type) {
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
        
        await sendMessage(phoneNoId, from, errorMessage);
    }
}

// Получение режима работы филиала
async function getLocationWorkingHours(locationId) {
    try {
        console.log(`🕐 Получаем режим работы для филиала ${locationId}`);
        
        const restaurantsResponse = await axios.get(`${TEMIR_API_BASE}/qr/restaurants`);
        const restaurants = restaurantsResponse.data;
        
        const restaurant = restaurants.find(r => r.external_id == locationId);
        
        if (restaurant && restaurant.schedule) {
            const today = new Date().getDay();
            const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const dayNamesRu = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
            
            const todayKey = dayNames[today];
            const todayNameRu = dayNamesRu[today];
            
            const todaySchedule = restaurant.schedule.find(s => s.day === todayKey);
            
            if (todaySchedule) {
                if (todaySchedule.active) {
                    const timeStart = todaySchedule.timeStart.substring(0, 5);
                    const timeEnd = todaySchedule.timeEnd.substring(0, 5);
                    
                    return `${todayNameRu}: ${timeStart} - ${timeEnd}`;
                } else {
                    return `${todayNameRu}: выходной`;
                }
            }
            
            const workingDays = restaurant.schedule.filter(s => s.active);
            if (workingDays.length > 0) {
                const firstDay = workingDays[0];
                const timeStart = firstDay.timeStart.substring(0, 5);
                const timeEnd = firstDay.timeEnd.substring(0, 5);
                return `Обычно: ${timeStart} - ${timeEnd}`;
            }
        }
        
        return "11:00 - 23:45";
        
    } catch (error) {
        console.error("❌ Ошибка получения режима работы:", error);
        return "11:00 - 23:45";
    }
}

// Отправка сообщения об успешном заказе
async function sendOrderSuccessMessage(phoneNoId, from, preorderResponse, orderType, finalAmount, locationTitle) {
    try {
        let successMessage = '';
        
        if (preorderResponse.status === 'success' && preorderResponse.data?.preorder_id) {
            successMessage = '🎉 Ваш заказ принят!\n\n';
            successMessage += `📋 Номер заказа: ${preorderResponse.data.preorder_id}\n\n`;
            
            if (orderType === 'pickup') {
                successMessage += `🏪 Самовывоз из филиала:\n`;
                successMessage += `📍 ${locationTitle}\n`;
                successMessage += `⏰ Заказ будет готов через 20-30 минут\n\n`;
            } else {
                successMessage += `🚗 Доставка по вашему адресу\n`;
                successMessage += `⏰ Ожидаемое время доставки: 30-40 минут\n\n`;
            }

            successMessage += `💰 Сумма к оплате: ${finalAmount} KGS\n\n`;
            successMessage += '📞 Наш менеджер свяжется с вами в ближайшее время для подтверждения заказа.\n\n';
            successMessage += '❓ Если у вас есть вопросы, пишите в этот чат или звоните нам!';
        } else if (preorderResponse.status === 'success') {
            successMessage = '✅ Ваш заказ обрабатывается!\n\n';
            successMessage += `💰 Сумма: ${finalAmount} KGS\n\n`;
            successMessage += '📞 Менеджер свяжется с вами для подтверждения деталей.';
        } else {
            successMessage = '❌ Произошла ошибка при оформлении заказа.\n\n';
            if (preorderResponse.message) {
                successMessage += `Детали: ${preorderResponse.message}\n\n`;
            }
            successMessage += 'Наш менеджер свяжется с вами для уточнения деталей.';
        }

        await sendMessage(phoneNoId, from, successMessage);
        
    } catch (error) {
        console.error('❌ Ошибка отправки сообщения об успехе:', error);
        await sendMessage(phoneNoId, from, '✅ Ваш заказ принят! Менеджер свяжется с вами в ближайшее время.');
    }
}

// Остальные функции обработки
async function handleButtonResponse(phoneNoId, from, message) {
    try {
        console.log("=== ОТВЕТ ОТ КНОПКИ ===");
        const buttonId = message.interactive.button_reply.id;
        console.log("Button ID:", buttonId);
    } catch (error) {
        console.error("Ошибка обработки ответа кнопки:", error);
    }
}

async function handleCatalogResponse(phoneNoId, from, message) {
    try {
        console.log("=== ОТВЕТ ОТ КАТАЛОГА (PRODUCT LIST) ===");
        console.log("Catalog response:", JSON.stringify(message.interactive, null, 2));
        
        await sendMessage(phoneNoId, from, "Спасибо за выбор! Обрабатываем ваш заказ...");
        
    } catch (error) {
        console.error("Ошибка обработки ответа каталога:", error);
        await sendMessage(phoneNoId, from, "Произошла ошибка при обработке заказа. Попробуйте еще раз.");
    }
}

// Кэш товаров
let productsCache = null;
let cacheExpiry = null;

// Получение всех товаров и кэширование
async function getAllProducts() {
    try {
        if (productsCache && cacheExpiry && Date.now() < cacheExpiry) {
            console.log("📦 Используем кэшированные товары");
            return productsCache;
        }
        
        console.log("🔄 Загружаем товары из API");
        const response = await axios.get(`${TEMIR_API_BASE}/qr/products`);
        const products = response.data;
        
        const productsMap = {};
        products.forEach(product => {
            productsMap[product.api_id] = {
                id: product.api_id,
                api_id: product.api_id,
                title: product.title,
                measure_unit: product.measure_unit_title || 'шт'
            };
        });
        
        productsCache = productsMap;
        cacheExpiry = Date.now() + (30 * 60 * 1000);
        
        console.log(`✅ Загружено ${products.length} товаров`);
        return productsMap;
        
    } catch (error) {
        console.error("❌ Ошибка загрузки товаров:", error.response?.status, error.response?.data);
        return productsCache || {};
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
async function sendWhatsAppMessage(phoneNoId, messageData) {
    try {
        const response = await axios({
            method: "POST",
            url: `https://graph.facebook.com/v22.0/${phoneNoId}/messages?access_token=${token}`,
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
async function sendCatalog(phoneNoId, to) {
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

    await sendWhatsAppMessage(phoneNoId, catalogData);
}

// Универсальная функция отправки текстового сообщения
async function sendMessage(phoneNoId, to, text) {
    const messageData = {
        messaging_product: "whatsapp",
        to: to,
        text: {
            body: text
        }
    };

    return await sendWhatsAppMessage(phoneNoId, messageData);
}

// Flow endpoint обработка
app.post("/flow", async (req, res) => {
    console.log("=== FLOW REQUEST ===");
    console.log("Headers:", JSON.stringify(req.headers, null, 2));
    console.log("Body:", JSON.stringify(req.body, null, 2));

    try {
        const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;

        if (!encrypted_flow_data || !encrypted_aes_key || !initial_vector) {
            console.log("❌ Missing encryption parameters");
            return res.status(421).json({ error: "Missing encryption parameters" });
        }

        const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptRequest(req.body);
        
        console.log("✅ Decrypted data:", JSON.stringify(decryptedBody, null, 2));

        const responseData = await processFlowData(decryptedBody);

        const encryptedResponse = encryptResponse(responseData, aesKeyBuffer, initialVectorBuffer);

        console.log("✅ Sending encrypted response");
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send(encryptedResponse);

    } catch (error) {
        console.error("❌ Flow endpoint error:", error);
        return res.status(421).json({ error: "Request processing failed" });
    }
});

// Функции шифрования/дешифрования
const decryptRequest = (body) => {
    const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;
    
    const privatePem = getPrivateKey();
    if (!privatePem) {
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
    const encryptedFlowDataBody = flowDataBuffer.subarray(0, -TAG_LENGTH);
    const encryptedFlowDataTag = flowDataBuffer.subarray(-TAG_LENGTH);

    const decipher = crypto.createDecipheriv(
        "aes-128-gcm",
        decryptedAesKey,
        initialVectorBuffer
    );
    
    decipher.setAuthTag(encryptedFlowDataTag);

    const decryptedJSONString = Buffer.concat([
        decipher.update(encryptedFlowDataBody),
        decipher.final(),
    ]).toString("utf-8");

    return {
        decryptedBody: JSON.parse(decryptedJSONString),
        aesKeyBuffer: decryptedAesKey,
        initialVectorBuffer,
    };
};

const encryptResponse = (response, aesKeyBuffer, initialVectorBuffer) => {
    const flippedIv = [];
    for (const pair of initialVectorBuffer.entries()) {
        flippedIv.push(~pair[1]);
    }

    const cipher = crypto.createCipheriv(
        "aes-128-gcm",
        aesKeyBuffer,
        Buffer.from(flippedIv)
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
async function handleDataExchange(screen, data, flowToken) {
    console.log(`📋 Data exchange for screen: ${screen}`, data);
    
    try {
        switch (screen) {
            case "WELCOME_NEW":
                return {
                    screen: "ORDER_TYPE_NEW",
                    data: {
                        flow_type: "new_customer",
                        customer_name: data.customer_name,
                        branches: data.branches
                    }
                };

            case "ORDER_TYPE_NEW":
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
                return {
                    screen: "SUCCESS",
                    data: {
                        extension_message_response: {
                            params: {
                                flow_token: flowToken,
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
                return {
                    screen: "PROMO_AND_TIME",
                    data: {
                        flow_type: "existing_customer",
                        customer_name: data.customer_name,
                        order_type: data.order_type,
                        user_addresses: data.user_addresses,
                        branches: data.branches,
                        branch: data.branch,
                        delivery_choice: data.delivery_choice,
                        new_address: data.new_address
                    }
                };

            case "PROMO_AND_TIME":
                return {
                    screen: "SUCCESS",
                    data: {
                        extension_message_response: {
                            params: {
                                flow_token: flowToken,
                                flow_type: "existing_customer",
                                customer_name: data