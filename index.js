const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
require('dotenv').config();

const app = express().use(body_parser.json());

const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN; // prasath_token

app.listen(process.env.PORT, () => {
    console.log("webhook is listening");
});

// to verify the callback url from dashboard side - cloud api side
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
                if (message.type === "interactive" && message.interactive.type === "nfm_reply") {
                    // Ответ от Flow - отправляем приветствие и каталог
                    await handleFlowResponse(phone_no_id, from, message, body_param);
                } else {
                    // Любое другое сообщение - отправляем Flow
                    await sendFlowMessage(phone_no_id, from);
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

// Асинхронная функция отправки Flow
async function sendFlowMessage(phone_no_id, to) {
    console.log("=== ОТПРАВКА FLOW ===");
    console.log("phone_no_id:", phone_no_id);
    console.log("to:", to);
    
    const flowData = {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
            type: "flow",
            body: {
                text: "🍣 Добро пожаловать в Yaposhkin Rolls!\n\nДля оформления заказа заполните форму:"
            },
            footer: {
                text: "Доставка по всему городу"
            },
            action: {
                name: "flow",
                parameters: {
                    flow_message_version: "3",
                    flow_token: "unused",
                    flow_id: "yaposhflows",
                    flow_cta: "Заполнить форму",
                    flow_action: "navigate"
                }
            }
        }
    };

    console.log("Flow data:", JSON.stringify(flowData, null, 2));

    // В начале sendFlowMessage добавьте:
console.log("TOKEN exists:", !!token);
console.log("TOKEN length:", token ? token.length : 0);
console.log("URL:", "https://graph.facebook.com/v22.0/" + phone_no_id + "/messages");

    try {
        const response = await axios({
            method: "POST",
            url: "https://graph.facebook.com/v22.0/" + phone_no_id + "/messages?access_token=" + token,
            data: flowData,
            headers: {
                "Content-Type": "application/json"
            }
        });
        
        console.log("✅ Flow отправлен успешно:", response.data);
        return response.data;
    } catch (error) {
        console.error("❌ Ошибка отправки Flow:");
        console.error("Status:", error.response?.status);
        console.error("Data:", error.response?.data);
        console.error("Message:", error.message);
        throw error;
    }
}

// Асинхронная функция обработки ответа от Flow
async function handleFlowResponse(phone_no_id, from, message, body_param) {
    try {
        console.log("=== ОБРАБОТКА FLOW ОТВЕТА ===");
        
        // Извлекаем данные из Flow ответа
        const flowResponse = JSON.parse(message.interactive.nfm_reply.response_json);
        const customerProfile = body_param.entry[0].changes[0].value.contacts[0].profile.name;
        
        console.log('Телефон клиента:', from);
        console.log('Имя профиля WhatsApp:', customerProfile);
        console.log('Данные из формы:', flowResponse);
        
        // Создаем данные заказа
        const orderData = {
            customer_phone: from,
            whatsapp_name: customerProfile,
            customer_name: flowResponse.customer_name,
            delivery_address: flowResponse.delivery_address,
            delivery_area: flowResponse.delivery_area,
            payment_method: flowResponse.payment_method,
            delivery_terms_accepted: flowResponse.delivery_terms,
            order_timestamp: new Date().toISOString(),
            message_id: message.id
        };

        console.log('Данные заказа сохранены:', orderData);

        // Отправляем приветствие
        await sendGreeting(phone_no_id, from, orderData);
        
        // Ждем 2 секунды и отправляем каталог
        setTimeout(async () => {
            try {
                await sendCatalog(phone_no_id, from);
            } catch (error) {
                console.error("Ошибка отправки каталога:", error);
            }
        }, 2000);

    } catch (error) {
        console.error("Ошибка обработки Flow ответа:", error);
        
        // Отправляем сообщение об ошибке
        await sendMessage(phone_no_id, from, "Произошла ошибка при обработке формы. Попробуйте еще раз.");
    }
}

// Асинхронная функция отправки приветствия
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

// Асинхронная функция отправки каталога
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

    try {
        const response = await axios({
            method: "POST",
            url: "https://graph.facebook.com/v22.0/" + phone_no_id + "/messages?access_token=" + token,
            data: catalogData,
            headers: {
                "Content-Type": "application/json"
            }
        });
        
        console.log("✅ Каталог отправлен успешно:", response.data);
        return response.data;
    } catch (error) {
        console.error("❌ Ошибка отправки каталога:");
        console.error("Status:", error.response?.status);
        console.error("Data:", error.response?.data);
        throw error;
    }
}

// Универсальная асинхронная функция отправки текстового сообщения
async function sendMessage(phone_no_id, to, text) {
    try {
        const response = await axios({
            method: "POST",
            url: "https://graph.facebook.com/v22.0/" + phone_no_id + "/messages?access_token=" + token,
            data: {
                messaging_product: "whatsapp",
                to: to,
                text: {
                    body: text
                }
            },
            headers: {
                "Content-Type": "application/json"
            }
        });
        
        console.log("✅ Сообщение отправлено:", response.data);
        return response.data;
    } catch (error) {
        console.error("❌ Ошибка отправки сообщения:");
        console.error("Status:", error.response?.status);
        console.error("Data:", error.response?.data);
        throw error;
    }
}

// Функция обработки ответа от Flow
function handleFlowResponse(phone_no_id, from, message, body_param) {
    try {
        // Извлекаем данные из Flow ответа
        const flowResponse = JSON.parse(message.interactive.nfm_reply.response_json);
        const customerProfile = body_param.entry[0].changes[0].value.contacts[0].profile.name;
        
        console.log('=== ОТВЕТ ОТ FLOW ===');
        console.log('Телефон клиента:', from);
        console.log('Имя профиля WhatsApp:', customerProfile);
        console.log('Данные из формы:', flowResponse);
        
        // Создаем данные заказа
        const orderData = {
            customer_phone: from,
            whatsapp_name: customerProfile,
            customer_name: flowResponse.customer_name,
            delivery_address: flowResponse.delivery_address,
            delivery_area: flowResponse.delivery_area,
            payment_method: flowResponse.payment_method,
            delivery_terms_accepted: flowResponse.delivery_terms,
            order_timestamp: new Date().toISOString(),
            message_id: message.id
        };

        // Сохраняем данные (здесь можно добавить сохранение в БД)
        console.log('Данные заказа сохранены:', orderData);

        // Отправляем приветствие
        sendGreeting(phone_no_id, from, orderData);
        
        // Через 2 секунды отправляем каталог
        setTimeout(() => {
            sendCatalog(phone_no_id, from);
        }, 2000);

    } catch (error) {
        console.error("Ошибка обработки Flow ответа:", error);
        
        // Отправляем сообщение об ошибке
        sendMessage(phone_no_id, from, "Произошла ошибка при обработке формы. Попробуйте еще раз.");
    }
}

// Функция отправки приветствия
function sendGreeting(phone_no_id, to, orderData) {
    const greetingText = `🎉 Спасибо, ${orderData.customer_name}!

✅ Ваши данные успешно сохранены:
👤 Имя: ${orderData.customer_name}
📍 Адрес доставки: ${orderData.delivery_address}
🏙️ Район: ${getAreaName(orderData.delivery_area)}
💳 Способ оплаты: ${getPaymentMethodName(orderData.payment_method)}

Сейчас отправлю вам наш каталог для выбора блюд! 🍣`;

    sendMessage(phone_no_id, to, greetingText);
}

// Функция отправки каталога
function sendCatalog(phone_no_id, to) {
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

    axios({
        method: "POST",
        url: "https://graph.facebook.com/v22.0/" + phone_no_id + "/messages?access_token=" + token,
        data: catalogData,
        headers: {
            "Content-Type": "application/json"
        }
    }).then(response => {
        console.log("Каталог отправлен успешно:", response.data);
    }).catch(error => {
        console.error("Ошибка отправки каталога:", error.response?.data || error.message);
    });
}

// Универсальная функция отправки текстового сообщения
function sendMessage(phone_no_id, to, text) {
    axios({
        method: "POST",
        url: "https://graph.facebook.com/v22.0/" + phone_no_id + "/messages?access_token=" + token,
        data: {
            messaging_product: "whatsapp",
            to: to,
            text: {
                body: text
            }
        },
        headers: {
            "Content-Type": "application/json"
        }
    }).then(response => {
        console.log("Сообщение отправлено:", response.data);
    }).catch(error => {
        console.error("Ошибка отправки сообщения:", error.response?.data || error.message);
    });
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