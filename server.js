require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors()); // Autorise ton app Flutter à communiquer avec ce serveur

// Récupération des variables sécurisées
const API_KEY = process.env.LIGDI_API_KEY;
const API_TOKEN = process.env.LIGDI_API_TOKEN;
const BASE_URL = process.env.LIGDI_BASE_URL;

// 1. ROUTE POUR INITIER UN PAIEMENT (Appelée par ton app Flutter)
app.post('/initiate-payment', async (req, res) => {
    const { amount, phone, description, orderId } = req.body;

    if (!amount || !phone || !orderId) {
        return res.status(400).json({ error: "Données manquantes (amount, phone, orderId)" });
    }

    try {
        // Préparation des données selon la structure attendue par LigdiCash
        const payload = {
            api_key: API_KEY,
            amount: parseInt(amount),
            currency: "XOF",
            phone: phone, // Format: 223XXXXXXXX
            description: description,
            order_id: orderId,
            callback_url: "https://ton-serveur-render.onrender.com/webhook" 
        };

        // Appel à l'API LigdiCash avec le Token dans l'en-tête
        const response = await axios.post(`${BASE_URL}/payment/initiate`, payload, {
            headers: {
                'Authorization': `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        // On renvoie la réponse (lien de paiement ou statut) à Flutter
        res.json(response.data);

    } catch (error) {
        console.error("Erreur LigdiCash:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Échec de l'initialisation du paiement" });
    }
});

// 2. ROUTE WEBHOOK (LigdiCash appelle cette route quand le paiement est fait)
app.post('/webhook', async (req, res) => {
    const data = req.body;
    console.log("🔔 Webhook reçu de LigdiCash:", data);

    // Vérifie si le paiement est un succès (le champ peut varier selon leur doc: 'status', 'statut', 'code')
    if (data.status === 'SUCCESS' || data.code === '00') {
        console.log(`✅ Paiement confirmé pour la commande: ${data.order_id}`);
        
        // ICI: Plus tard, on mettra à jour Supabase/Firebase pour débloquer le cours
    }

    // Toujours répondre 200 OK pour confirmer la réception
    res.status(200).send('OK');
});

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur LigdiCash actif sur le port ${PORT}`);
});