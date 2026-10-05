require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');

// ==========================================
// ✅ CONNEXION FIRESTORE
// ==========================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();

// ==========================================
// ✅ MIDDLEWARES - CAPTURE DU BODY BRUT (traçabilité)
// ==========================================
app.use(cors());
app.use(express.urlencoded({
  extended: true,
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));

// ==========================================
// ✅ VARIABLES DE CONFIGURATION
// ==========================================
const API_KEY = process.env.LIGDI_API_KEY;
const API_TOKEN = process.env.LIGDI_API_TOKEN;
const MIN_AMOUNT = parseInt(process.env.MIN_AMOUNT || '10', 10); // 1000 par défaut, 10 pour tests
const CALLBACK_VIEW_TOKEN = process.env.CALLBACK_VIEW_TOKEN || 'smartedu_default_token_2024';

console.log(`⚙️  Config: MIN_AMOUNT=${MIN_AMOUNT} FCFA`);

// ==========================================
// ✅ SYSTÈME DE TRAÇABILITÉ DES CALLBACKS
// ==========================================
const callbackLogs = []; // mémoire (200 derniers)

async function saveCallbackLog(entry) {
  callbackLogs.unshift(entry);
  if (callbackLogs.length > 200) callbackLogs.pop();
  
  console.log('\n📥 ═══════════════════════════════════════');
  console.log('   CALLBACK ENREGISTRÉ');
  console.log('════════════════════════════════════════');
  console.log('   ├─ Heure:', entry.receivedAt);
  console.log('   ├─ Chemin:', entry.path);
  console.log('   ├─ Méthode:', entry.method);
  console.log('   ├─ IP:', entry.ip);
  console.log('   Body:', JSON.stringify(entry.body, null, 2));
  console.log('════════════════════════════════════════\n');
  
  // Persistance Firestore (optionnelle, non bloquante)
  try {
    await db.collection('ligdicash_callbacks').add({
      ...entry,
      savedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.log('⚠️ Sauvegarde Firestore callback ignorée:', e.message);
  }
}

// ==========================================
// HELPERS
// ==========================================
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

function formatPhoneNumber(phone) {
    if (!phone) return '';
    let cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);
    if (cleaned.startsWith('00')) cleaned = cleaned.substring(2);
    if (/^0[0-9]{7,8}$/.test(cleaned)) cleaned = '223' + cleaned.substring(1);
    return cleaned;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// 1. INITIER UN PAIEMENT (premium / library / group)
// ==========================================
app.post('/initiate-payment', async (req, res) => {
    const { amount, phone, description, orderId, uid, type, itemId } = req.body;

    console.log('\n💳 ═══════════════════════════════════════');
    console.log('   INITIATE PAYMENT');
    console.log('════════════════════════════════════════');
    console.log('   ├─ Type:', type);
    console.log('   ├─ ItemId:', itemId || 'aucun');
    console.log('   ├─ Amount:', amount);
    console.log('   ├─ Phone:', phone);
    console.log('   ├─ UID:', uid);
    console.log('   └─ OrderId:', orderId);
    console.log('════════════════════════════════════════\n');

    if (!amount || !phone || !orderId || !uid || !type) {
        return res.status(400).json({ error: "Données manquantes (uid/type requis)" });
    }

    // ✅ VALIDATION : montant minimum configurable
    const amountNum = parseInt(amount);
    if (amountNum < MIN_AMOUNT) {
        return res.status(400).json({ 
            error: `Montant minimum : ${MIN_AMOUNT} FCFA`,
            minimum: MIN_AMOUNT
        });
    }

    try {
        let sellerId = null;
        let productTitle = '';
        let productPrice = amountNum;
        
        if (type === 'library' && itemId) {
            try {
                const productSnap = await db.collection('digital_products').doc(itemId).get();
                if (productSnap.exists) {
                    const productData = productSnap.data();
                    sellerId = productData.sellerId || null;
                    productTitle = productData.title || '';
                    productPrice = productData.price || amountNum;
                    console.log(`📦 Produit: "${productTitle}" (${productPrice}F)`);
                }
            } catch (err) {
                console.log(`⚠️ Erreur produit: ${err.message}`);
            }
        }
        
        if (type === 'group' && itemId) {
            try {
                const groupSnap = await db.collection('groups').doc(itemId).get();
                if (groupSnap.exists) {
                    const groupData = groupSnap.data();
                    sellerId = groupData.teacherId || null;
                    productTitle = groupData.title || '';
                    productPrice = groupData.priceYearly || amountNum;
                    console.log(`👥 Groupe: "${productTitle}" (${productPrice}F)`);
                }
            } catch (err) {
                console.log(`⚠️ Erreur groupe: ${err.message}`);
            }
        }

        const payload = {
            commande: {
                invoice: {
                    items: [],
                    total_amount: amountNum,
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

        console.log('📤 Envoi à LigdiCash...');

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
        console.log('📥 Réponse LigdiCash:', JSON.stringify(data, null, 2));

        if (data.response_code === '00' && data.token) {
            const start = new Date();
            const oneYear = 365 * 24 * 60 * 60 * 1000;
            const end = (type === 'premium' || type === 'group')
                ? new Date(start.getTime() + oneYear)
                : null;

            await db.collection('purchases').doc(orderId).set({
                uid: uid,
                phone: phone,
                type: type,
                itemId: itemId || null,
                sellerId: sellerId,
                productTitle: productTitle,
                productPrice: productPrice,
                amount: amountNum,
                status: 'pending',
                token: data.token,
                orderId: orderId,
                startDate: admin.firestore.Timestamp.fromDate(start),
                endDate: end ? admin.firestore.Timestamp.fromDate(end) : null,
                createdAt: new Date().toISOString()
            });
            console.log(`✅ Transaction ${orderId} créée pour ${uid}`);
        }

        res.json(data);
    } catch (error) {
        console.error("❌ Erreur LigdiCash:", error.response ? error.response.data : error.message);
        res.status(500).json({
            error: "Échec de l'initialisation",
            details: error.response ? error.response.data : error.message
        });
    }
});

// ==========================================
// 2. WEBHOOK PAIEMENT (existant, + traçabilité)
// ==========================================
app.post('/webhook', async (req, res) => {
    // ✅ TRAÇABILITÉ : journaliser AVANT traitement
    await saveCallbackLog({
        receivedAt: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        ip: req.ip,
        headers: req.headers,
        query: req.query,
        body: req.body,
        rawBody: req.rawBody || null,
        source: 'paiement_webhook'
    });
    
    console.log("\n🔔 ═══════════════════════════════════════");
    console.log("   WEBHOOK PAIEMENT REÇU");
    console.log("════════════════════════════════════════");
    console.log("Body:", JSON.stringify(req.body, null, 2));
    console.log("════════════════════════════════════════\n");
    
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
            await payRef.update({
                status: 'completed',
                confirmedAt: new Date().toISOString()
            });

            if (pay.type === 'premium') {
                await db.collection('users').doc(pay.uid).update({
                    isPremium: true,
                    premiumStartDate: pay.startDate,
                    premiumEndDate: pay.endDate,
                    premiumOrderId: orderId
                });
                console.log(`🎉 PREMIUM ACTIVÉ pour ${pay.uid}`);
            }
            else if (pay.type === 'group' && pay.itemId) {
                try {
                    const memberRef = db.collection('group_members').doc();
                    await memberRef.set({
                        groupId: pay.itemId,
                        userId: pay.uid,
                        status: 'active',
                        purchaseId: orderId,
                        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
                        expiresAt: pay.endDate,
                        paymentAmount: pay.amount,
                    });
                    console.log(`🎉 ÉLÈVE AJOUTÉ AU GROUPE ${pay.itemId}`);
                    
                    try {
                        await db.collection('groups').doc(pay.itemId).update({
                            membersCount: admin.firestore.FieldValue.increment(1)
                        });
                    } catch (e) {
                        console.log('⚠️ membersCount update:', e.message);
                    }
                } catch (err) {
                    console.error('❌ Erreur ajout membre:', err.message);
                }
            }
            else {
                console.log(`🎉 ACHAT VALIDÉ (${pay.type}): ${pay.itemId}`);
            }
        } else if (status === 'notcompleted') {
            await payRef.update({ status: 'notcompleted' });
            console.log(`❌ Paiement échoué: ${orderId}`);
        }
    } catch (e) {
        console.error('❌ Erreur webhook:', e.message);
    }
});

// ==========================================
// ✅ NOUVELLES ROUTES CALLBACK (traçabilité)
// ==========================================
const CALLBACK_PATHS = [
  '/callback',
  '/callback/ligdicash',
  '/ligdicash/callback',
  '/callback/payment',
  '/payment/callback',
  '/webhook/callback',
];

app.all(CALLBACK_PATHS, async (req, res) => {
    await saveCallbackLog({
        receivedAt: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        ip: req.ip,
        headers: req.headers,
        query: req.query,
        body: req.body,
        rawBody: req.rawBody || null,
        source: 'callback_generic'
    });
    
    res.status(200).json({ 
        status: 'ok', 
        received: true,
        timestamp: new Date().toISOString(),
        path: req.originalUrl
    });
});

// ==========================================
// ✅ ENDPOINT DE CONSULTATION DES LOGS
// ==========================================
app.get('/callbacks', (req, res) => {
    if (req.query.token !== CALLBACK_VIEW_TOKEN) {
        return res.status(403).json({ error: 'Token invalide' });
    }
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 200);
    const orderId = req.query.order_id || req.query.orderId;
    const source = req.query.source;
    
    let list = callbackLogs;
    if (orderId) list = list.filter(l => JSON.stringify(l).includes(orderId));
    if (source) list = list.filter(l => l.source === source);
    
    res.json({ 
        count: list.length, 
        callbacks: list.slice(0, limit),
        serverTime: new Date().toISOString()
    });
});

// ==========================================
// ✅ ENDPOINT DE TEST : GÉNÉRATEUR LIEN 10 FCFA
// ==========================================
app.post('/test/payment-link', async (req, res) => {
    const { phone, amount = 10, description = 'Test de validation LigdiCash' } = req.body || {};
    
    if (!phone) {
        return res.status(400).json({ error: 'Phone requis' });
    }
    
    const orderId = 'TEST-' + Date.now();
    const formattedPhone = formatPhoneNumber(phone);
    
    console.log(`\n🧪 ═══════════════════════════════════════`);
    console.log(`   TEST PAYMENT LINK`);
    console.log(`   ├─ Phone: ${formattedPhone}`);
    console.log(`   ├─ Amount: ${amount} FCFA`);
    console.log(`   └─ OrderId: ${orderId}`);
    console.log(`════════════════════════════════════════\n`);
    
    try {
        const payload = {
            commande: {
                invoice: {
                    items: [],
                    total_amount: parseInt(amount),
                    devise: "XOF",
                    description: description,
                    customer: "",
                    customer_firstname: "Test",
                    customer_lastname: "Validation",
                    customer_email: "test@smarteduafrica.com",
                    external_id: orderId,
                    otp: ""
                },
                store: {
                    name: "SmartEduAfrica Test",
                    website_url: "https://smarteduafrica.com"
                },
                actions: {
                    cancel_url: "",
                    return_url: "",
                    callback_url: "https://ligdicash-api.onrender.com/webhook"
                },
                custom_data: {
                    transaction_id: orderId,
                    user_uid: "test-validation",
                    purchase_type: "test",
                    item_id: "test"
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
        
        // Créer entrée purchase de test
        if (data.response_code === '00' && data.token) {
            await db.collection('purchases').doc(orderId).set({
                uid: 'test-validation',
                phone: formattedPhone,
                type: 'test',
                itemId: 'test',
                sellerId: null,
                productTitle: 'Test validation',
                productPrice: parseInt(amount),
                amount: parseInt(amount),
                status: 'pending',
                token: data.token,
                orderId: orderId,
                createdAt: new Date().toISOString()
            });
        }

        res.json({ 
            orderId, 
            amount: parseInt(amount),
            ...data,
            message: 'Lien de paiement généré. Transmettez-le à LigdiCash.'
        });
    } catch (error) {
        console.error('❌ Erreur test:', error.response?.data || error.message);
        res.status(500).json({ 
            error: "Erreur",
            details: error.response?.data || error.message
        });
    }
});

// ==========================================
// 3. RETRAIT - PAYOUT MARCHAND
// ==========================================
app.post('/process-withdrawal', async (req, res) => {
    const { 
        sellerId, amount, phone, provider,
        sellerName, source
    } = req.body;

    const withdrawalSource = source || 'library';

    if (!sellerId || !amount || !phone) {
        return res.status(400).json({ 
            success: false, 
            error: "Données manquantes (sellerId, amount, phone requis)" 
        });
    }

    if (amount <= 0) {
        return res.status(400).json({ 
            success: false, 
            error: "Le montant doit être supérieur à 0" 
        });
    }

    const formattedPhone = formatPhoneNumber(phone);
    
    if (!/^[0-9]{10,15}$/.test(formattedPhone)) {
        return res.status(400).json({
            success: false,
            error: `Numéro invalide: ${formattedPhone}. Format: 223XXXXXXXX`
        });
    }
    
    console.log(`\n💸 ═══════════════════════════════════════`);
    console.log(`   RETRAIT DEMANDÉ (Source: ${withdrawalSource})`);
    console.log(`════════════════════════════════════════`);
    console.log(`   ├─ Vendeur: ${sellerId}`);
    console.log(`   ├─ Montant: ${amount} FCFA`);
    console.log(`   └─ Numéro: ${formattedPhone}`);
    console.log(`════════════════════════════════════════\n`);

    const withdrawalRef = db.collection('withdrawal_requests').doc();
    
    try {
        console.log(`🔍 Calcul du solde (${withdrawalSource})...`);
        
        let totalRevenue = 0.0;
        
        if (withdrawalSource === 'groups') {
            try {
                const groupsSnap = await db.collection('groups')
                    .where('teacherId', '==', sellerId).get();
                
                for (const groupDoc of groupsSnap.docs) {
                    const groupData = groupDoc.data();
                    const priceYearly = (groupData.priceYearly || 0);
                    
                    try {
                        const salesSnap = await db.collection('purchases')
                            .where('itemId', '==', groupDoc.id)
                            .where('type', '==', 'group')
                            .where('status', '==', 'completed').get();
                        
                        totalRevenue += salesSnap.docs.length * priceYearly * 0.80;
                    } catch (e) {}
                }
            } catch (e) {}
        } else {
            const myProductIds = new Set();
            try {
                const productsSnap = await db.collection('digital_products')
                    .where('sellerId', '==', sellerId).get();
                for (const doc of productsSnap.docs) myProductIds.add(doc.id);
            } catch (e) {}
            
            try {
                const salesSnap = await db.collection('purchases')
                    .where('sellerId', '==', sellerId)
                    .where('status', '==', 'completed').get();
                for (const sale of salesSnap.docs) {
                    totalRevenue += (sale.data().productPrice || 0) * 0.80;
                }
            } catch (e) {}
            
            try {
                const allSales = await db.collection('purchases')
                    .where('type', '==', 'library')
                    .where('status', '==', 'completed').get();
                for (const sale of allSales.docs) {
                    const data = sale.data();
                    if (myProductIds.has(data.itemId) && data.sellerId !== sellerId) {
                        totalRevenue += (data.productPrice || 0) * 0.80;
                    }
                }
            } catch (e) {}
        }
        
        let withdrawn = 0.0;
        try {
            const paidSnap = await db.collection('withdrawal_requests')
                .where('sellerId', '==', sellerId)
                .where('source', '==', withdrawalSource)
                .where('status', '==', 'paid').get();
            for (const doc of paidSnap.docs) withdrawn += doc.data().netAmount || 0;
        } catch (e) {
            try {
                const paidSnap = await db.collection('withdrawal_requests')
                    .where('sellerId', '==', sellerId)
                    .where('status', '==', 'paid').get();
                for (const doc of paidSnap.docs) {
                    const data = doc.data();
                    if (!data.source || data.source === withdrawalSource) withdrawn += data.netAmount || 0;
                }
            } catch (e2) {}
        }
        
        let pending = 0.0;
        try {
            const pendingSnap = await db.collection('withdrawal_requests')
                .where('sellerId', '==', sellerId)
                .where('source', '==', withdrawalSource)
                .where('status', 'in', ['pending', 'processing', 'approved']).get();
            for (const doc of pendingSnap.docs) pending += doc.data().amount || 0;
        } catch (e) {
            try {
                const pendingSnap = await db.collection('withdrawal_requests')
                    .where('sellerId', '==', sellerId)
                    .where('status', 'in', ['pending', 'processing', 'approved']).get();
                for (const doc of pendingSnap.docs) {
                    const data = doc.data();
                    if (!data.source || data.source === withdrawalSource) pending += data.amount || 0;
                }
            } catch (e2) {}
        }
        
        const availableBalance = Math.max(0, totalRevenue - withdrawn - pending);
        
        console.log(`💰 Solde: ${availableBalance.toFixed(2)}F | Demandé: ${amount}F`);
        
        if (amount > availableBalance) {
            return res.status(400).json({
                success: false,
                error: `Solde insuffisant. Disponible: ${Math.floor(availableBalance)} FCFA`,
                availableBalance: Math.floor(availableBalance)
            });
        }
        
        const fee = Math.round(amount * 0.05);
        const netAmount = Math.round(amount - fee);
        
        await withdrawalRef.set({
            sellerId, sellerName: sellerName || '',
            sellerPhone: phone, sellerPhoneFormatted: formattedPhone,
            mobileMoneyProvider: provider || 'auto',
            amount, fee, netAmount,
            status: 'processing',
            source: withdrawalSource,
            createdAt: new Date().toISOString(),
            processedAt: new Date().toISOString(),
            paidAt: null, failedAt: null, failureReason: null, retryCount: 0,
        });
        
        const payload = {
            commande: {
                amount: netAmount,
                description: `Retrait SmartEdu ${withdrawalRef.id.substring(0, 8)}`,
                customer: formattedPhone,
                callback_url: "https://ligdicash-api.onrender.com/webhook-withdrawal",
                custom_data: { transaction_id: `WITHDRAW-${withdrawalRef.id}` }
            }
        };
        
        let payoutResponse = null;
        let lastError = null;
        const maxRetries = 3;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await axios.post(
                    'https://app.ligdicash.com/pay/v01/straight/payout',
                    payload,
                    {
                        headers: {
                            'Apikey': API_KEY,
                            'Authorization': `Bearer ${API_TOKEN}`,
                            'Accept': 'application/json',
                            'Content-Type': 'application/json'
                        },
                        timeout: 30000
                    }
                );
                payoutResponse = response.data;
                if (payoutResponse.response_code === '00') break;
                if (payoutResponse.response_code === '09' && attempt < maxRetries) await delay(2000);
                else break;
            } catch (error) {
                lastError = error;
                if (attempt < maxRetries) await delay(2000);
            }
        }
        
        if (!payoutResponse && lastError) {
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: `Erreur réseau après ${maxRetries} tentatives: ${lastError.message}`,
                retryCount: maxRetries
            });
            return res.status(500).json({
                success: false,
                error: "Erreur de connexion. Réessayez.",
                withdrawalId: withdrawalRef.id
            });
        }
        
        const isInitiated = payoutResponse.response_code === '00';
        const ligdiCashToken = payoutResponse.token || null;
        
        if (isInitiated) {
            await withdrawalRef.update({
                status: 'processing',
                ligdiCashTransactionId: ligdiCashToken,
                ligdiCashResponse: payoutResponse,
                initiatedAt: new Date().toISOString()
            });
            console.log(`✅ PAYOUT INITIÉ: ${netAmount}F → ${formattedPhone}`);
            
            return res.json({
                success: true,
                message: `✅ Retrait de ${netAmount} FCFA initié`,
                withdrawalId: withdrawalRef.id,
                transactionId: ligdiCashToken,
                netAmount, fee,
                status: 'processing'
            });
        } else {
            const errorReason = payoutResponse.response_text || 
                               payoutResponse.description ||
                               payoutResponse.message || 
                               `Code: ${payoutResponse.response_code}`;
            const isIpError = payoutResponse.response_code === '14';
            const shouldFallback = isIpError || payoutResponse.response_code === '09';
            
            if (shouldFallback) {
                await withdrawalRef.update({
                    status: 'pending',
                    failedAt: new Date().toISOString(),
                    failureReason: `Auto échoué (${payoutResponse.response_code}): ${errorReason}`,
                    ligdiCashResponse: payoutResponse,
                    responseCode: payoutResponse.response_code,
                    retryCount: maxRetries,
                    manualApprovalRequired: true,
                    autoAttemptedAt: new Date().toISOString()
                });
                
                return res.status(200).json({
                    success: true,
                    message: `📋 Demande enregistrée. Admin traitera sous 24-48h.`,
                    withdrawalId: withdrawalRef.id,
                    netAmount, fee,
                    status: 'pending',
                    requiresManualApproval: true
                });
            }
            
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: errorReason,
                ligdiCashResponse: payoutResponse,
                responseCode: payoutResponse.response_code,
                retryCount: maxRetries
            });
            
            return res.status(400).json({
                success: false,
                error: errorReason,
                responseCode: payoutResponse.response_code,
                withdrawalId: withdrawalRef.id
            });
        }
        
    } catch (error) {
        console.error('❌ ERREUR CRITIQUE:', error.message);
        try {
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: 'Erreur serveur: ' + error.message
            });
        } catch (e) {}
        
        res.status(500).json({
            success: false,
            error: "Erreur serveur.",
            details: error.message,
            withdrawalId: withdrawalRef.id
        });
    }
});

// ==========================================
// 4. WEBHOOK RETRAIT
// ==========================================
app.post('/webhook-withdrawal', async (req, res) => {
    // ✅ TRAÇABILITÉ
    await saveCallbackLog({
        receivedAt: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        ip: req.ip,
        headers: req.headers,
        query: req.query,
        body: req.body,
        rawBody: req.rawBody || null,
        source: 'withdrawal_webhook'
    });
    
    console.log('\n🔔 WEBHOOK RETRAIT REÇU');
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    res.status(200).send('OK');

    try {
        const body = req.body;
        let withdrawalId = extractCustom(body.custom_data, 'withdrawal_id');
        let transactionId = extractCustom(body.custom_data, 'transaction_id');
        
        if (!withdrawalId && transactionId && transactionId.startsWith('WITHDRAW-')) {
            withdrawalId = transactionId.replace('WITHDRAW-', '');
        }
        if (!withdrawalId && body.external_id) {
            withdrawalId = body.external_id.replace('WITHDRAW-', '');
        }
        if (!withdrawalId && body.custom_data && typeof body.custom_data === 'object') {
            withdrawalId = body.custom_data.withdrawal_id;
        }
        
        if (!withdrawalId) {
            console.log('⚠️ withdrawalId introuvable');
            return;
        }

        const withdrawalRef = db.collection('withdrawal_requests').doc(withdrawalId);
        const snap = await withdrawalRef.get();
        if (!snap.exists) return;

        const currentData = snap.data();
        const status = (body.status || '').toLowerCase();
        const responseCode = body.response_code;

        if (status === 'completed' || status === 'success' || responseCode === '00') {
            if (currentData.status !== 'paid') {
                await withdrawalRef.update({
                    status: 'paid',
                    paidAt: new Date().toISOString(),
                    ligdiCashWebhookResponse: body
                });
                console.log(`✅ Retrait ${withdrawalId} PAYÉ`);
            }
        } 
        else if (status === 'pending' || status === 'processing') {
            console.log(`⏳ Retrait ${withdrawalId} en cours`);
        }
        else if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'notcompleted') {
            const failureReason = body.response_text || body.message || 'Erreur LigdiCash';
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: failureReason,
                ligdiCashWebhookResponse: body
            });
            console.log(`❌ Retrait ${withdrawalId} ÉCHOUÉ: ${failureReason}`);
        }
    } catch (e) {
        console.error('❌ Erreur webhook retrait:', e.message);
    }
});

// ==========================================
// 5. ROUTE DE SANTÉ
// ==========================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'LigdiCash SmartEduAfrica API',
        version: '5.0 - Validation Mode',
        endpoints: [
            'POST /initiate-payment (premium/library/group)',
            'POST /webhook (confirmation paiements)',
            'POST /webhook-withdrawal (confirmations retraits)',
            'POST /process-withdrawal (retraits)',
            'POST /test/payment-link (tests validation)',
            'GET  /callbacks?token=... (logs)',
            'ALL  /callback, /callback/ligdicash, ... (traçabilité)'
        ],
        config: {
            minAmount: MIN_AMOUNT + ' FCFA',
            callbackViewEnabled: true,
            firestoreLogs: true
        },
        timestamp: new Date().toISOString()
    });
});

// ==========================================
// DÉMARRAGE
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  🚀 LigdiCash SmartEduAfrica v5.0            ║');
    console.log('║  Port: ' + PORT + '                                  ║');
    console.log('║  MIN_AMOUNT: ' + MIN_AMOUNT + ' FCFA                      ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log('📡 Endpoints :');
    console.log('   ├─ POST /initiate-payment');
    console.log('   ├─ POST /webhook');
    console.log('   ├─ POST /process-withdrawal');
    console.log('   ├─ POST /webhook-withdrawal');
    console.log('   ├─ POST /test/payment-link (validation)');
    console.log('   └─ GET  /callbacks?token=' + CALLBACK_VIEW_TOKEN);
    console.log('');
    console.log('📥 Routes traçabilité : ' + CALLBACK_PATHS.join(', '));
    console.log('');
});