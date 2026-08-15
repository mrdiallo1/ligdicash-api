require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors()); 

const API_KEY = process.env.LIGDI_API_KEY;
const API_TOKEN = process.env.LIGDI_API_TOKEN;

// 1. ROUTE POUR INITIER UN PAIEMENT
app.post('/initiate-payment', async (req, res) => {
    const { amount, phone, description, orderId } = req.body;

    if (!amount || !phone || !orderId) {
        return res.status(400).json({ error: "Données manquantes" });
    }

    try {
        // Payload envoyé à LigdiCash
        const payload = {
            amount: parseInt(amount),
            currency: "XOF",
            phone: phone, 
            description: description,
            order_id: orderId,
            // Callback URL pour que LigdiCash nous prévienne quand c'est payé
            callback_url: "https://ligdicash-api.onrender.com/webhook" 
        };

        // ✅ APPEL À LA VRAIE URL DE LIGDICASH
        const response = await axios.post(
            'https://app.ligdicash.com/pay/v01/straight/checkout-invoice/create', 
            payload, 
            {
                headers: {
                    'Apikey': API_KEY, // ✅ Clé API dans le header
                    'Authorization': `Bearer ${API_TOKEN}`, // ✅ Token dans le header
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json(response.data);

    } catch (error) {
        // On renvoie les détails de l'erreur pour pouvoir les lire dans Flutter
        console.error("Erreur LigdiCash:", error.response ? error.response.data : error.message);
        res.status(500).json({ 
            error: "Échec de l'initialisation", 
            details: error.response ? error.response.data : error.message 
        });
    }
});

// 2. ROUTE WEBHOOK (Pour recevoir les confirmations de paiement)
app.post('/webhook', async (req, res) => {
    console.log("🔔 Webhook reçu de LigdiCash:", req.body);
    res.status(200).send('OK');
});

// Render utilise le port 10000 par défaut
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur LigdiCash actif sur le port ${PORT}`);
});