const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');

const app = express().use(body_parser.json());

const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN;

// Конфигурация
const TEMIR_API_BASE = 'https://ya.temir.me';

// Flow IDs
const NEW_CUSTOMER_FLOW_ID = '4265839023734503'; // newCustomer
const ORDER_FLOW_ID = '708820881926236'; // order

app.listen(process.env.PORT, () => {
    console.log("webhook is listening");
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
                if (message.type === "interactive") {
                    console.log("Interactive message type:", message.interactive.type);
                    
                    if (message.interactive.type === "nfm_reply") {
                        // Ответ от Flow
                        console.log("🔄 Обрабатываем ответ от Flow");
                        await handleFlowResponse(phone_no_id, from, message, body_param);
                    } else if (message.interactive.type === "product_list_reply") {
                        // Ответ от каталога - отправляем подтверждение заказа и order flow
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
                    // Любое другое сообщение - проверяем клиента и отправляем каталог
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
            await sendNewCustomerFlow(phone_no_id, from);
        } else {
            console.log('✅ Существующий клиент - отправляем приветствие и каталог');
            await sendExistingCustomerGreeting(phone_no_id, from, customerData.customer);
        }

    } catch (error) {
        console.error('❌ Ошибка проверки клиента:', error);
        
        // В случае ошибки API - считаем новым клиентом
        console.log('🆕 Ошибка API - отправляем регистрационный Flow');
        await sendNewCustomerFlow(phone_no_id, from);
    }
}

// Отправка Flow для новых клиентов
async function sendNewCustomerFlow(phone_no_id, from) {
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
                    flow_action: "navigate"
                }
            }
        }
    };

    await sendWhatsAppMessage(phone_no_id, flowData);
}

// Приветствие и каталог для существующих клиентов
async function sendExistingCustomerGreeting(phone_no_id, from, customer) {
    // Приветствие
    const greetingText = `Привет, ${customer.first_name}! 👋\n\nРады снова вас видеть в Yaposhkin Rolls! 🍣\n\nВыберите блюда из нашего каталога:`;
    await sendMessage(phone_no_id, from, greetingText);

    // Отправляем каталог сразу после приветствия
    setTimeout(async () => {
        await sendCatalog(phone_no_id, from);
    }, 1000);
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
        
        if (order && order.product_items) {
            console.log("=== ДЕТАЛИ ТОВАРОВ ===");
            
            // Обрабатываем товары последовательно, чтобы получить названия из API
            for (let index = 0; index < order.product_items.length; index++) {
                const item = order.product_items[index];
                console.log(`Товар ${index + 1}:`, JSON.stringify(item, null, 2));
                
                // Получаем информацию о товаре из API
                const productInfo = await getProductInfo(item.product_retailer_id);
                
                const productName = productInfo.title || `Товар ${item.product_retailer_id}`;
                console.log(`Название товара: ${productName}`);
                
                orderSummary += `${index + 1}. ${productName}\n`;
                orderSummary += `Количество: ${item.quantity} ${productInfo.measure_unit || 'шт'}\n`;
                
                if (item.item_price) {
                    const itemTotal = parseFloat(item.item_price) * item.quantity;
                    orderSummary += `Цена: ${item.item_price} ${item.currency || 'KGS'} x ${item.quantity} = ${itemTotal} ${item.currency || 'KGS'}\n`;
                    totalAmount += itemTotal;
                }
                
                orderSummary += "\n";
            }
        }
        
        orderSummary += `💰 Общая стоимость: ${totalAmount} KGS\n`;
        orderSummary += "\n📍 Теперь выберите способ получения заказа:";
        
        await sendMessage(phone_no_id, from, orderSummary);
        
        // Отправляем order flow через 2 секунды
        setTimeout(async () => {
            await sendOrderFlow(phone_no_id, from);
        }, 2000);
        
    } catch (error) {
        console.error("Ошибка обработки order ответа каталога:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при обработке заказа. Попробуйте еще раз.");
    }
}

// Обработка ответа от кнопок
async function handleButtonResponse(phone_no_id, from, message) {
    try {
        console.log("=== ОТВЕТ ОТ КНОПКИ ===");
        const buttonId = message.interactive.button_reply.id;
        
        if (buttonId === "order_flow") {
            await sendOrderFlow(phone_no_id, from);
        }
    } catch (error) {
        console.error("Ошибка обработки ответа кнопки:", error);
    }
}

// Обработка ответа от каталога
async function handleCatalogResponse(phone_no_id, from, message) {
    try {
        console.log("=== ОТВЕТ ОТ КАТАЛОГА (PRODUCT LIST) ===");
        console.log("Catalog response:", JSON.stringify(message.interactive, null, 2));
        
        const productListReply = message.interactive.product_list_reply;
        
        // Формируем информацию о заказе
        let orderSummary = "🛒 Ваш заказ:\n\n";
        
        // Здесь должна быть логика подсчета стоимости из вашего каталога
        orderSummary += "📋 Выбранные товары:\n";
        if (productListReply.single_product_reply) {
            orderSummary += `• ${productListReply.single_product_reply.product_retailer_id}\n`;
        } else {
            orderSummary += `• Выбранные блюда\n`;
        }
        orderSummary += "\n💰 Стоимость: уточняется\n";
        orderSummary += "\n📍 Теперь выберите способ получения заказа:";
        
        await sendMessage(phone_no_id, from, orderSummary);
        
        // Отправляем order flow через 2 секунды
        setTimeout(async () => {
            await sendOrderFlow(phone_no_id, from);
        }, 2000);
        
    } catch (error) {
        console.error("Ошибка обработки ответа каталога:", error);
        await sendMessage(phone_no_id, from, "Произошла ошибка при обработке заказа. Попробуйте еще раз.");
    }
}

// Отправка order flow
async function sendOrderFlow(phone_no_id, from) {
    console.log("=== ОТПРАВКА ORDER FLOW ===");
    
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
                text: "Настройте детали вашего заказа"
            },
            footer: {
                text: "Выберите тип доставки и время"
            },
            action: {
                name: "flow",
                parameters: {
                    flow_message_version: "3",
                    flow_token: `order_${Date.now()}`,
                    flow_id: ORDER_FLOW_ID,
                    flow_cta: "Оформить заказ",
                    flow_action: "navigate",
                    flow_action_payload: {
                    user_address: "ул. Исы Ахунбаева 125в, кв. 10" // Ваш адрес
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
        } else {
            // Это order flow - обрабатываем заказ
            await handleOrderCompletion(phone_no_id, from, flowResponse);
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

        // Здесь отправляем данные в Temir API для создания клиента
        const customerData = {
            phone: from,
            first_name: data.first_name,
            last_name: data.last_name || '',
            address: data.address
        };

        // await axios.post(`${TEMIR_API_BASE}/customers/`, customerData);

        // Отправляем подтверждение регистрации
        const confirmText = `Спасибо за регистрацию, ${data.first_name}! 🎉\n\nТеперь вы можете делать заказы. Сейчас отправлю вам наш каталог! 🍣`;
        await sendMessage(phone_no_id, from, confirmText);

        // Отправляем каталог через 2 секунды
        setTimeout(async () => {
            await sendCatalog(phone_no_id, from);
        }, 2000);

    } catch (error) {
        console.error('❌ Ошибка регистрации:', error);
        await sendMessage(phone_no_id, from, 'Извините, произошла ошибка при регистрации. Попробуйте позже.');
    }
}

// Обработка завершения заказа (order flow)
async function handleOrderCompletion(phone_no_id, from, data) {
    try {
        console.log('✅ Завершаем заказ:', data);

        // Получаем детальную информацию о филиале если самовывоз
        let branchInfo = null;
        if (data.order_type === 'pickup' && data.branch) {
            branchInfo = await getBranchInfo(data.branch);
        }

        // Сохраняем заказ в базе данных или отправляем в API
        const orderData = {
            phone: from,
            order_type: data.order_type,
            branch_id: data.branch,
            delivery_choice: data.delivery_choice,
            new_address: data.new_address,
            preparation_time: data.preparation_time,
            specific_time: data.specific_time,
            promo_code: data.promo_code,
            comment: data.comment
        };

        // TODO: Отправить заказ в Temir API
        // await axios.post(`${TEMIR_API_BASE}/orders/`, orderData);

        // Формируем итоговое сообщение
        let successMessage = '🎉 Заказ успешно оформлен!\n\n';
        
        if (data.order_type === 'pickup') {
            if (branchInfo) {
                successMessage += `📍 Самовывоз из филиала:\n`;
                successMessage += `🏪 ${branchInfo.title}\n`;
                successMessage += `📍 ${branchInfo.address}\n`;
                if (branchInfo.phone) {
                    successMessage += `📞 ${branchInfo.phone}\n`;
                }
            } else {
                successMessage += `📍 Самовывоз из выбранного филиала\n`;
            }
        } else {
            successMessage += `🚗 Доставка по адресу\n`;
        }

        if (data.preparation_time === 'specific') {
            successMessage += `⏰ Время: ${data.specific_time}\n`;
        } else {
            successMessage += `⚡ Готовим как можно скорее\n`;
        }

        if (data.promo_code) {
            successMessage += `🎁 Промокод: ${data.promo_code}\n`;
        }

        if (data.comment) {
            successMessage += `💬 Комментарий: ${data.comment}\n`;
        }

        successMessage += '\n✅ Заказ принят в обработку!';
        successMessage += '\n⏳ Ожидайте звонка от нашего менеджера для подтверждения деталей.';

        await sendMessage(phone_no_id, from, successMessage);

    } catch (error) {
        console.error('❌ Ошибка завершения заказа:', error);
        await sendMessage(phone_no_id, from, 'Извините, произошла ошибка при оформлении заказа. Наш менеджер свяжется с вами.');
    }
}

// Обработка старого формата Flow (для совместимости)
async function handleLegacyFlowResponse(phone_no_id, from, flowResponse, customerProfile) {
    const orderData = {
        customer_phone: from,
        whatsapp_name: customerProfile,
        customer_name: flowResponse.customer_name,
        delivery_address: flowResponse.delivery_address,
        delivery_area: flowResponse.delivery_area,
        payment_method: flowResponse.payment_method,
        delivery_terms_accepted: flowResponse.delivery_terms,
        order_timestamp: new Date().toISOString()
    };

    console.log('Данные заказа сохранены:', orderData);

    await sendGreeting(phone_no_id, from, orderData);
    
    setTimeout(async () => {
        await sendCatalog(phone_no_id, from);
    }, 2000);
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

// Отправка приветствия (для совместимости)
async function sendGreeting(phone_no_id, to, orderData) {
    const greetingText = `🎉 Спасибо, ${orderData.customer_name}!

✅ Ваши данные успешно сохранены:
👤 Имя: ${orderData.customer_name}
📍 Адрес доставки: ${orderData.delivery_address}
🏙️ Район: ${getAreaName(orderData.delivery_area)}
💳 Способ оплаты: ${getPaymentMethodName(orderData.payment_method)}

Сейчас отправлю вам наш каталог для выбора блюд! 🍣`;

    return await sendMessage(phone_no_id, to, greetingText);
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

// Вспомогательные функции
function getAreaName(areaCode) {
    const areas = {
        'center': 'Центр города',
        'north': 'Северный район',
        'south': 'Южный район',
        'east': 'Восточный район',
        'west': 'Западный район'
    };
    return areas[areaCode] || areaCode;
}

function getPaymentMethodName(method) {
    const methods = {
        'cash': 'Наличными курьеру',
        'card': 'Банковской картой',
        'transfer': 'Переводом'
    };
    return methods[method] || method;
}


// Flow endpoint с исправленным шифрованием
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

        // Расшифровываем данные
        const decryptedData = await decryptFlowData(encrypted_flow_data, encrypted_aes_key, initial_vector);
        
        if (!decryptedData) {
            console.log("❌ Failed to decrypt flow data");
            return res.status(421).json({ error: "Decryption failed" });
        }

        console.log("✅ Decrypted data:", JSON.stringify(decryptedData, null, 2));

        // Обрабатываем расшифрованные данные
        const responseData = await processFlowData(decryptedData);

        // Шифруем ответ
        const encryptedResponse = await encryptFlowResponse(responseData, encrypted_aes_key, initial_vector);

        if (!encryptedResponse) {
            console.log("❌ Failed to encrypt response");
            return res.status(500).json({ error: "Encryption failed" });
        }

        console.log("✅ Sending encrypted response");
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send(encryptedResponse);

    } catch (error) {
        console.error("❌ Flow endpoint error:", error);
        return res.status(421).json({ error: "Request processing failed" });
    }
});

// Исправленная функция расшифровки для старого Node.js
async function decryptFlowData(encryptedData, encryptedKey, iv) {
    try {
        console.log("🔓 Starting decryption process...");
        
        // Декодируем из base64
        const encryptedBuffer = Buffer.from(encryptedData, 'base64');
        const encryptedKeyBuffer = Buffer.from(encryptedKey, 'base64');
        const ivBuffer = Buffer.from(iv, 'base64');
        
        console.log("📏 Buffer lengths:", {
            data: encryptedBuffer.length,
            key: encryptedKeyBuffer.length,
            iv: ivBuffer.length
        });

        // Получаем приватный ключ
        const privateKey = getPrivateKey();
        if (!privateKey) {
            throw new Error("Private key not found");
        }

        // Расшифровываем AES ключ
        const aesKey = crypto.privateDecrypt(
            {
                key: privateKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256'
            },
            encryptedKeyBuffer
        );

        console.log("🔑 AES key decrypted, length:", aesKey.length);

        // Используем AES-128-CBC вместо GCM для совместимости
        const decipher = crypto.createDecipher('aes-128-cbc', aesKey.slice(0, 16));
        decipher.setAutoPadding(true);
        
        // Расшифровываем данные
        let decrypted = decipher.update(encryptedBuffer, null, 'utf8');
        decrypted += decipher.final('utf8');

        console.log("✅ Decryption successful");
        return JSON.parse(decrypted);

    } catch (error) {
        console.error("❌ Decryption error:", error);
        
        // Fallback: попробуем другие методы
        try {
            console.log("🔄 Trying alternative decryption...");
            return await decryptFlowDataAlternative(encryptedData, encryptedKey, iv);
        } catch (altError) {
            console.error("❌ Alternative decryption also failed:", altError);
            return null;
        }
    }
}

// Альтернативный метод расшифровки
async function decryptFlowDataAlternative(encryptedData, encryptedKey, iv) {
    try {
        const encryptedBuffer = Buffer.from(encryptedData, 'base64');
        const encryptedKeyBuffer = Buffer.from(encryptedKey, 'base64');
        const ivBuffer = Buffer.from(iv, 'base64');
        
        const privateKey = getPrivateKey();
        const aesKey = crypto.privateDecrypt(
            {
                key: privateKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256'
            },
            encryptedKeyBuffer
        );

        // Пробуем AES-128-CTR
        const decipher = crypto.createDecipher('aes-128-ctr', aesKey.slice(0, 16));
        let decrypted = decipher.update(encryptedBuffer, null, 'utf8');
        decrypted += decipher.final('utf8');

        return JSON.parse(decrypted);
        
    } catch (error) {
        throw error;
    }
}

// Исправленная функция шифрования
async function encryptFlowResponse(responseData, encryptedKey, iv) {
    try {
        console.log("🔒 Starting encryption process...");
        
        // Декодируем ключ
        const encryptedKeyBuffer = Buffer.from(encryptedKey, 'base64');
        
        // Получаем приватный ключ и расшифровываем AES ключ
        const privateKey = getPrivateKey();
        const aesKey = crypto.privateDecrypt(
            {
                key: privateKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256'
            },
            encryptedKeyBuffer
        );

        // Конвертируем ответ в JSON строку
        const responseString = JSON.stringify(responseData);
        console.log("📤 Response to encrypt:", responseString);

        // Используем AES-128-CBC для совместимости
        const cipher = crypto.createCipher('aes-128-cbc', aesKey.slice(0, 16));
        
        // Шифруем данные
        let encrypted = cipher.update(responseString, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        
        console.log("✅ Encryption successful");
        return encrypted;

    } catch (error) {
        console.error("❌ Encryption error:", error);
        return null;
    }
}

// Упрощенная обработка Flow данных
async function processFlowData(data) {
    console.log("🔄 Processing flow data:", data);
    
    try {
        // Если данные не расшифровались полностью, возвращаем базовый ответ
        if (!data || typeof data !== 'object') {
            console.log("📝 Using default response for health check");
            return {
                version: "5.0",
                data: {
                    status: "active"
                }
            };
        }

        const { version, action, flow_token, data: flowData } = data;
        
        console.log(`Processing: version=${version}, action=${action}, token=${flow_token}`);

        switch (action) {
            case "ping":
                return {
                    version: "5.0",
                    data: {
                        status: "active"
                    }
                };

            case "INIT":
                return {
                    version: "5.0",
                    data: {
                        screen: "welcome",
                        flow_token: flow_token || "default_token"
                    }
                };

            case "data_exchange":
                return {
                    version: "5.0",
                    data: {
                        success: true,
                        message: "Data received successfully"
                    }
                };

            default:
                return {
                    version: "5.0",
                    data: {
                        status: "active",
                        message: "Flow endpoint working"
                    }
                };
        }
    } catch (error) {
        console.error("❌ Flow processing error:", error);
        return {
            version: "5.0",
            data: {
                status: "active"
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
            supportedAlgorithms: crypto.getCiphers().filter(c => c.includes('aes')),
            method: "AES-128-CBC + RSA-OAEP (fallback mode)"
        }
    };
    
    console.log("📊 Flow status:", status);
    res.status(200).json(status);
});

// Простой fallback endpoint если шифрование не работает
app.post("/flow-simple", (req, res) => {
    console.log("🔧 Simple flow endpoint called");
    
    // Возвращаем минимальный ответ для проверки работоспособности
    const response = {
        version: "5.0",
        data: {
            status: "active"
        }
    };
    
    const responseBase64 = Buffer.from(JSON.stringify(response)).toString('base64');
    
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(responseBase64);
});


app.get("/", (req, res) => {
    res.status(200).send("hello this is webhook setup");
});