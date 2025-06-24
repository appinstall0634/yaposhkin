const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
require('dotenv').config();

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
            console.log("message:", JSON.stringify(message, null, 2));

            try {
                // Проверяем тип сообщения
                if (message.type === "interactive") {
                    if (message.interactive.type === "nfm_reply") {
                        // Ответ от Flow
                        await handleFlowResponse(phone_no_id, from, message, body_param);
                    } else if (message.interactive.type === "product_list_reply") {
                        // Ответ от каталога - отправляем подтверждение заказа и order flow
                        await handleCatalogResponse(phone_no_id, from, message);
                    }
                } else {
                    // Любое другое сообщение - проверяем клиента и отправляем каталог
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
    
    // Проверяем если это команда для заказа
    if (messageText && (messageText.includes('заказ') || messageText.includes('меню') || messageText.includes('каталог'))) {
        await checkCustomerAndSendFlow(phone_no_id, from);
    } else {
        // Для любого другого сообщения тоже проверяем клиента
        await checkCustomerAndSendFlow(phone_no_id, from);
    }
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
                text: "Добро пожаловать! Для начала давайте познакомимся 😊"
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

// Обработка ответа от каталога
async function handleCatalogResponse(phone_no_id, from, message) {
    try {
        console.log("=== ОТВЕТ ОТ КАТАЛОГА ===");
        console.log("Catalog response:", JSON.stringify(message.interactive, null, 2));
        
        const productListReply = message.interactive.product_list_reply;
        
        // Формируем информацию о заказе
        let orderSummary = "🛒 Ваш заказ:\n\n";
        let totalAmount = 0;
        
        // Здесь должна быть логика подсчета стоимости из вашего каталога
        // Пока что показываем примерную информацию
        orderSummary += "📋 Выбранные товары:\n";
        orderSummary += `• ${productListReply.title || 'Выбранные блюда'}\n`;
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
                    flow_action: "navigate"
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

app.get("/", (req, res) => {
    res.status(200).send("hello this is webhook setup");
});