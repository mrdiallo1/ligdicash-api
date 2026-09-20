require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');

// ✅ Connexion Firestore (pour activer Premium + enregistrer achats)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.LIGDI_API_KEY;
const API_TOKEN = process.env.LIGDI_API_TOKEN;

// ==========================================
// 1. INITIER UN PAIEMENT (premium / library / group)
// ==========================================
app.post('/initiate-payment', async (req, res) => {
    const { amount, phone, description, orderId, uid, type, itemId } = req.body;

    if (!amount || !phone || !orderId || !uid || !type) {
        return res.status(400).json({ error: "Données manquantes (uid/type requis)" });
    }

    try {
        // ✅ NOUVEAU : Récupérer sellerId et infos produit pour les achats library
        let sellerId = null;
        let productTitle = '';
        let productPrice = parseInt(amount);
        
        if (type === 'library' && itemId) {
            try {
                const productSnap = await db.collection('digital_products').doc(itemId).get();
                if (productSnap.exists) {
                    const productData = productSnap.data();
                    sellerId = productData.sellerId || null;
                    productTitle = productData.title || '';
                    productPrice = productData.price || parseInt(amount);
                    console.log(`📦 Produit trouvé: "${productTitle}" (vendeur: ${sellerId}, prix: ${productPrice}F)`);
                } else {
                    console.log(`⚠️ Produit introuvable: ${itemId}`);
                }
            } catch (err) {
                console.log(`⚠️ Erreur récupération produit: ${err.message}`);
            }
        }

        const payload = {
            commande: {
                invoice: {
                    items: [],
                    total_amount: parseInt(amount),
                    devise: "XOF",
                    description: description || "Achat SmartEduAfrica",
                    customer: "",
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
                    transaction_id: orderId,
                    user_uid: uid,
                    purchase_type: type,
                    item_id: itemId || ''
                }
            }
        };

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

        const data = response.data;

        // ✅ Stocke la transaction dans Firestore pour le webhook
        if (data.response_code === '00' && data.token) {
            const start = new Date();
            const oneYear = 365 * 24 * 60 * 60 * 1000;
            const end = (type === 'premium' || type === 'group')
                ? new Date(start.getTime() + oneYear)
                : null;

            // ✅ Document enrichi avec sellerId, productTitle, productPrice
            await db.collection('purchases').doc(orderId).set({
                uid: uid,
                phone: phone,
                type: type,
                itemId: itemId || null,
                sellerId: sellerId,           // ✅ NOUVEAU - permet aux profs de voir leurs ventes
                productTitle: productTitle,   // ✅ NOUVEAU - utile pour stats
                productPrice: productPrice,   // ✅ NOUVEAU - prix officiel du produit
                amount: parseInt(amount),
                status: 'pending',
                token: data.token,
                orderId: orderId,             // ✅ NOUVEAU - référence explicite
                startDate: admin.firestore.Timestamp.fromDate(start),
                endDate: end ? admin.firestore.Timestamp.fromDate(end) : null,
                createdAt: new Date().toISOString()
            });
            console.log(`✅ Transaction ${orderId} (${type}) créée pour ${uid}`);
            console.log(`   ├─ sellerId: ${sellerId || 'aucun'}`);
            console.log(`   ├─ itemId: ${itemId || 'aucun'}`);
            console.log(`   └─ titre: "${productTitle}"`);
        }

        res.json(data);
    } catch (error) {
        console.error("Erreur LigdiCash:", error.response ? error.response.data : error.message);
        res.status(500).json({
            error: "Échec de l'initialisation",
            details: error.response ? error.response.data : error.message
        });
    }
});

// Helper : extrait une valeur de custom_data (tableau OU objet)
function extractCustom(custom, key) {
    if (!custom) return null;
    if (Array.isArray(custom)) {
        for (const item of custom) {
            if (item && typeof item === 'object' && item[key] !== undefined) return item[key];
        }
        return null;
    }
    return custom[key] ?? null;
}

// ==========================================
// 2. WEBHOOK : valide le paiement + enregistre
// ==========================================
app.post('/webhook', async (req, res) => {
    console.log("🔔 WEBHOOK REÇU:", JSON.stringify(req.body));
    res.status(200).send('OK');

    try {
        const body = req.body;
        const orderId = extractCustom(body.custom_data, 'transaction_id') || body.external_id;
        if (!orderId) { console.log('⚠️ orderId introuvable'); return; }

        const payRef = db.collection('purchases').doc(orderId);
        const snap = await payRef.get();
        if (!snap.exists) { console.log('⚠️ Achat inconnu:', orderId); return; }

        const pay = snap.data();
        if (pay.status === 'completed') { console.log('ℹ️ Déjà traité'); return; }

        // ✅ Vérification officielle avec le token stocké
        const confirm = await axios.get(
            `https://app.ligdicash.com/pay/v01/redirect/checkout-invoice/confirm/?invoiceToken=${pay.token}`,
            {
                headers: {
                    Apikey: API_KEY,
                    Authorization: `Bearer ${API_TOKEN}`,
                    Accept: 'application/json'
                }
            }
        );
        console.log('✅ CONFIRM:', JSON.stringify(confirm.data));
        const status = confirm.data.status;

        if (status === 'completed') {
            // Marque l'achat comme validé
            await payRef.update({
                status: 'completed',
                confirmedAt: new Date().toISOString()
            });

            // ✅ Si PREMIUM → met à jour users/{uid}
            if (pay.type === 'premium') {
                await db.collection('users').doc(pay.uid).update({
                    isPremium: true,
                    premiumStartDate: pay.startDate,
                    premiumEndDate: pay.endDate,
                    premiumOrderId: orderId
                });
                console.log(`🎉 PREMIUM ACTIVÉ (1 an) pour ${pay.uid}`);
            } else {
                console.log(`🎉 ACHAT VALIDÉ (${pay.type}) : ${pay.itemId} pour ${pay.uid}`);
                console.log(`   ├─ Vendeur: ${pay.sellerId || 'inconnu'}`);
                console.log(`   └─ Produit: "${pay.productTitle}" (${pay.productPrice}F)`);
            }
        } else if (status === 'notcompleted') {
            await payRef.update({ status: 'notcompleted' });
            console.log(`❌ Paiement échoué: ${orderId}`);
        }
    } catch (e) {
        console.error('❌ Erreur webhook:', e.message);
    }
});

app.get('/', (req, res) => res.send('Serveur LigdiCash SmartEduAfrica actif ✅'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Serveur actif sur le port ${PORT}`));