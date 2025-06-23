
        // Конвертер JSON в CSV
        function convertMenuJsonToCSV(jsonData) {
            const BASE_LINK = "https://yaposhkinrolls.com";
            const BRAND = "Yaposhkin Rolls";
            const AVAILABILITY = "in stock";
            const CONDITION = "new";
            const IMAGE_BASE_URL = "https://ve738.quickresto.ru/wlcrm";
            
            const headers = [
                "id", "title", "description", "availability", 
                "condition", "price", "link", "image_link", "brand",
                "google_product_category", "fb_product_category"
            ];
            
            function getCategory(groupId, title) {
                const categories = {
                    14: { google: "Food, Beverages & Tobacco > Beverages", fb: "Напитки" },
                    27: { google: "Food, Beverages & Tobacco > Beverages", fb: "Напитки" },
                    39: { google: "Food, Beverages & Tobacco > Beverages", fb: "Напитки" },
                    11: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Сеты" },
                    24: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Сеты" },
                    36: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Сеты" },
                    40: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Теплые сеты" },
                    1: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Роллы" },
                    8: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Классические роллы" },
                    16: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Роллы" },
                    21: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Классические Роллы" },
                    28: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Роллы" },
                    33: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Классические Роллы" },
                    2: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Теплые роллы" },
                    17: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Теплые роллы" },
                    29: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Теплые роллы" },
                    6: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Темпура роллы" },
                    20: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Темпура роллы" },
                    32: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Темпура роллы" },
                    3: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Роллы без риса" },
                    18: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Роллы без риса" },
                    30: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Роллы без риса" },
                    5: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Суши и гунканы" },
                    19: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Суши и Гунканы" },
                    31: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Суши и Гунканы" },
                    9: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Сладкие роллы" },
                    22: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Сладкие Роллы" },
                    34: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Сладкие Роллы" },
                    10: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Салаты" },
                    23: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Салаты" },
                    35: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Салаты" },
                    12: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Новинки" },
                    25: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Новинки" },
                    37: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Новинки" },
                    4: { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Круассаны" },
                    13: { google: "Food, Beverages & Tobacco > Food Items > Accessories", fb: "Дополнительно" },
                    26: { google: "Food, Beverages & Tobacco > Food Items > Accessories", fb: "Доп соус и приборы" },
                    38: { google: "Food, Beverages & Tobacco > Food Items > Accessories", fb: "Доп соус и приборы" }
                };
                
                if (categories[groupId]) return categories[groupId];
                
                const titleLower = title.toLowerCase();
                if (titleLower.includes('сет') || titleLower.includes('set')) return { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Сеты" };
                if (titleLower.includes('напиток') || titleLower.includes('кола') || titleLower.includes('спрайт') || titleLower.includes('фанта') || titleLower.includes('чай') || titleLower.includes('сок')) return { google: "Food, Beverages & Tobacco > Beverages", fb: "Напитки" };
                if (titleLower.includes('темпура') || titleLower.includes('tempura')) return { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Темпура роллы" };
                if (titleLower.includes('теплый') || titleLower.includes('теплые') || titleLower.includes('запеченный')) return { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Теплые роллы" };
                if (titleLower.includes('суши') || titleLower.includes('гункан')) return { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Суши и гунканы" };
                if (titleLower.includes('салат')) return { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Салаты" };
                if (titleLower.includes('сладкий') || titleLower.includes('сладкие')) return { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Сладкие роллы" };
                
                return { google: "Food, Beverages & Tobacco > Food Items > Prepared Foods", fb: "Роллы" };
            }
            
            function isAvailableForLocation1(sales) {
                if (!sales || sales.length === 0) return false;
                return sales.some(sale => sale.locationId === 1);
            }
            
            function cleanDescription(description) {
                if (!description) return "";
                return description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
            }
            
            function getPrice(sales) {
                if (!sales || sales.length === 0) return "0 KGS";
                
                const firstSale = sales[0];
                const price = firstSale.priceExternal || firstSale.price || 0;
                
                let formattedPrice = price;
                if (price > 1000) {
                    formattedPrice = (price / 100).toFixed(0);
                }
                
                return `${formattedPrice} KGS`;
            }
            
            function getImageLink(imageUrl) {
                if (!imageUrl) return "";
                return IMAGE_BASE_URL + imageUrl;
            }
            
            let data;
            try {
                data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
            } catch (error) {
                throw new Error('Ошибка парсинга JSON: ' + error.message);
            }
            
            const items = data.data || data;
            if (!Array.isArray(items)) {
                throw new Error('Данные должны быть массивом');
            }
            
            const csvRows = [headers.join(',')];
            
            items.forEach(item => {
                // Проверяем доступность для locationId: 1
                if (!isAvailableForLocation1(item.sales)) {
                    return; // Пропускаем товар
                }
                
                const category = getCategory(item.groupId, item.title || '');
                const row = [
                    item.id || '',
                    `"${(item.title || '').replace(/"/g, '""')}"`,
                    `"${cleanDescription(item.description).replace(/"/g, '""')}"`,
                    AVAILABILITY,
                    CONDITION,
                    getPrice(item.sales),
                    BASE_LINK,
                    getImageLink(item.imageUrl),
                    BRAND,
                    category.google,
                    category.fb
                ];
                csvRows.push(row.join(','));
            });
            
            return csvRows.join('\n');
        }

        function downloadCSV(csvContent, filename = 'yaposhkin_rolls_catalog.csv') {
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', filename);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            showResult(`✅ Файл ${filename} скачан!`, 'Проверьте папку "Загрузки"');
        }

        function showResult(title, content) {
            document.getElementById('result').style.display = 'block';
            document.getElementById('resultContent').innerHTML = `
                <h4>${title}</h4>
                <p>${content}</p>
            `;
        }

        function processJsonFile(file) {
            const reader = new FileReader();
            
            reader.onload = function(e) {
                try {
                    const csvContent = convertMenuJsonToCSV(e.target.result);
                    downloadCSV(csvContent);
                } catch (error) {
                    showResult('❌ Ошибка', error.message);
                }
            };
            
            reader.readAsText(file);
        }

        function convertFromText() {
            const jsonText = document.getElementById('jsonText').value.trim();
            
            if (!jsonText) {
                showResult('⚠️ Внимание', 'Пожалуйста, вставьте JSON текст');
                return;
            }
            
            try {
                const csvContent = convertMenuJsonToCSV(jsonText);
                downloadCSV(csvContent);
            } catch (error) {
                showResult('❌ Ошибка', error.message);
            }
        }

        function testConversion() {
            const sampleData = {
                "data": [
                    {
                        "id": 914,
                        "title": "Сет Запеченный трио",
                        "imageUrl": "/static/876",
                        "description": "Микс запеченный (8шт), ролл с крабом и паприкой (8шт), запеченный пармезан (8шт)",
                        "sales": [
                            {
                                "locationId": 20,
                                "price": 9500.00000,
                                "priceExternal": 10500.00000
                            }
                        ]
                    },
                    {
                        "id": 915,
                        "title": "Сет Темпура трио",
                        "imageUrl": "/static/878",
                        "description": "Темпура с лососем (8шт), темпура с креветками (8шт), темпура с крабом (8шт)",
                        "sales": [
                            {
                                "locationId": 28,
                                "price": 1500.00000,
                                "priceExternal": 1900.00000
                            }
                        ]
                    }
                ]
            };
            
            try {
                const csvContent = convertMenuJsonToCSV(sampleData);
                downloadCSV(csvContent, 'test_menu.csv');
            } catch (error) {
                showResult('❌ Ошибка теста', error.message);
            }
        }

        // Обработка загрузки файла
        document.getElementById('jsonFile').addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                showResult('⏳ Обработка', 'Конвертируем файл...');
                processJsonFile(file);
            }
        });

        // Drag & Drop
        const uploadArea = document.getElementById('uploadArea');
        
        uploadArea.addEventListener('dragover', function(e) {
            e.preventDefault();
            uploadArea.style.borderColor = '#25D366';
        });
        
        uploadArea.addEventListener('dragleave', function(e) {
            e.preventDefault();
            uploadArea.style.borderColor = '#ccc';
        });
        
        uploadArea.addEventListener('drop', function(e) {
            e.preventDefault();
            uploadArea.style.borderColor = '#ccc';
            
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                const file = files[0];
                if (file.type === 'application/json' || file.name.endsWith('.json')) {
                    showResult('⏳ Обработка', 'Конвертируем файл...');
                    processJsonFile(file);
                } else {
                    showResult('⚠️ Неверный тип файла', 'Пожалуйста, загрузите JSON файл');
                }
            }
        });
