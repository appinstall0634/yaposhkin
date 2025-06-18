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

app.post("/webhook", (req, res) => {
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

            let response_text = "";

            // Обрабатываем разные типы сообщений
            if (message.text && message.text.body) {
                // Текстовое сообщение
                let msg_body = message.text.body;
                console.log("text message: " + msg_body);
                response_text = "Hi.. I'm Prasath, your message is " + msg_body;
                
            } else if (message.type === "order" && message.order) {
                // Заказ из каталога
                console.log("Order received from catalog!");
                console.log("Order details:", JSON.stringify(message.order, null, 2));
                
                let order = message.order;
                let orderText = "🛒 Спасибо за заказ!\n\n";
                
                // Каталог ID
                if (order.catalog_id) {
                    orderText += "📋 Каталог ID: " + order.catalog_id + "\n";
                }
                
                // Текст заказа (если есть)
                if (order.text && order.text.trim() !== "") {
                    orderText += "💬 Комментарий: " + order.text + "\n";
                }
                
                // Проверяем наличие товаров
                if (order.product_items && order.product_items.length > 0) {
                    orderText += "\n📦 Товары в заказе:\n";
                    
                    let totalAmount = 0;
                    let currency = "";
                    
                    order.product_items.forEach((item, index) => {
                        orderText += `${index + 1}. `;
                        
                        // ID товара
                        if (item.product_retailer_id) {
                            orderText += `Товар ID: ${item.product_retailer_id}\n`;
                        }
                        
                        // Количество
                        if (item.quantity) {
                            orderText += `   Количество: ${item.quantity}\n`;
                        }
                        
                        // Цена
                        if (item.item_price) {
                            orderText += `   Цена за единицу: ${item.item_price}`;
                            if (item.currency) {
                                orderText += ` ${item.currency}`;
                                currency = item.currency;
                            }
                            orderText += "\n";
                            
                            // Подсчитываем общую сумму
                            if (item.quantity) {
                                totalAmount += item.item_price * item.quantity;
                            }
                        }
                        
                        orderText += "\n";
                    });
                    
                    // Общая сумма
                    if (totalAmount > 0) {
                        orderText += `💰 Общая сумма: ${totalAmount} ${currency}\n\n`;
                    }
                    
                } else {
                    orderText += "\n📦 Товары в заказе: информация недоступна\n\n";
                }
                
                orderText += "✅ Ваш заказ принят в обработку. Мы свяжемся с вами в ближайшее время!\n";
                orderText += "📞 Контакт: " + from;
                
                response_text = orderText;
                
            } else if (message.type === "interactive") {
                // Интерактивные сообщения (кнопки, списки)
                console.log("Interactive message received");
                
                if (message.interactive.type === "button_reply") {
                    let button = message.interactive.button_reply;
                    response_text = "Вы выбрали: " + button.title;
                } else if (message.interactive.type === "list_reply") {
                    let list = message.interactive.list_reply;
                    response_text = "Вы выбрали из списка: " + list.title;
                }
                
            } else {
                // Другие типы сообщений
                console.log("Message type:", message.type);
                response_text = "Получено сообщение типа: " + (message.type || "unknown");
            }

            // Отправляем ответ
            axios({
                method: "POST",
                url: "https://graph.facebook.com/v22.0/" + phone_no_id + "/messages?access_token=" + token,
                data: {
                    messaging_product: "whatsapp",
                    to: from,
                    text: {
                        body: response_text
                    }
                },
                headers: {
                    "Content-Type": "application/json"
                }
            }).catch(error => {
                console.error("Error sending message:", error.response?.data || error.message);
            });

            res.sendStatus(200);
        } else {
            res.sendStatus(404);
        }
    }
});

app.get("/", (req, res) => {
    res.status(200).send("hello this is webhook setup");
});