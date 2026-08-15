require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.LIGDI_API_KEY;
const API_TOKEN = process.env.LIGDI_API_TOKEN;

// 1. ROUTE POUR INITIER UN PAIEMENT (Format officiel LigdiCash)
app.post('/initiate-payment', async (req, res) => {
    const { amount, phone, description, orderId } = req.body;

    if (!amount || !phone || !orderId) {
        return res.status(400).json({ error: "Données manquantes" });
    }

    try {
        // ✅ STRUCTURE OFFICIELLE EXIGÉE PAR LIGDICASH
        const payload = {
            commande: {
                invoice: {
                    items: [],
                    total_amount: parseInt(amount),
                    devise: "XOF",
                    description: description || "Abonnement SmartEduAfrica",
                    customer: phone, // Format: 223XXXXXXXX
                    customer_firstname: "Client",
                    customer_lastname: "SmartEdu",
                    customer_email: "client@smarteduafrica.com",
                    external_id: orderId,
                    otp: ""
                },
                store: {
                    name: "SmartEduAfrica",
                    website_url: "https://smarteduafrica.com"
                },
                actions: {
                    cancel_url: "",
                    return_url: "",
                    callback_url: "https://ligdicash-api.onrender.com/webhook"
                },
                custom_data: {
                    transaction_id: orderId
                }
            }
        };

        // ✅ Endpoint "Hosted payin" : ouvre la page de paiement LigdiCash
        const response = await axios.post(
            'https://app.ligdicash.com/pay/v01/redirect/checkout-invoice/create',
            payload,
            {
                headers: {
                    'Apikey': API_KEY,
                    'Authorization': `Bearer ${API_TOKEN}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json(response.data);

    } catch (error) {
        console.error("Erreur LigdiCash:", error.response ? error.response.data : error.message);
        res.status(500).json({
            error: "Échec de l'initialisation",
            details: error.response ? error.response.data : error.message
        });
    }
});

// 2. ROUTE WEBHOOK (confirmation automatique de paiement)
app.post('/webhook', async (req, res) => {
    console.log("🔔 Webhook LigdiCash reçu:", JSON.stringify(req.body));
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur LigdiCash actif sur le port ${PORT}`);
});