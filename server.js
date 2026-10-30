
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');

// ==========================================
// 1. CONNEXION FIRESTORE
// ==========================================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT est manquant.');
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

// ==========================================
// 2. MIDDLEWARES
// ==========================================
app.use(cors());

app.use(express.urlencoded({
    extended: true,
    verify: (req, res, buf) => {
        req.rawBody = buf.toString('utf8');
    }
}));

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString('utf8');
    }
}));

// ==========================================
// 3. CONFIGURATION
// ==========================================
const API_KEY = process.env.LIGDI_API_KEY;
const API_TOKEN = process.env.LIGDI_API_TOKEN;
const MIN_AMOUNT = parseInt(process.env.MIN_AMOUNT || '10', 10);
const CALLBACK_VIEW_TOKEN = process.env.CALLBACK_VIEW_TOKEN;

const DONKS_PACKS = (process.env.DONKS_PACKS || '500,1000,2000,3000')
    .split(',')
    .map(value => parseInt(value.trim(), 10))
    .filter(value => Number.isSafeInteger(value) && value > 0);

const LIGDI_BASE_URL = 'https://app.ligdicash.com';
const PAYMENT_CALLBACK_URL =
    'https://ligdicash-api.onrender.com/webhook';
const WITHDRAWAL_CALLBACK_URL =
    'https://ligdicash-api.onrender.com/webhook-withdrawal';

if (!API_KEY || !API_TOKEN) {
    console.warn('⚠️ LIGDI_API_KEY ou LIGDI_API_TOKEN manquant.');
}

console.log(`⚙️ MIN_AMOUNT=${MIN_AMOUNT} FCFA`);
console.log(`⚙️ Packs Donks autorisés : ${DONKS_PACKS.join(', ')}`);

// ==========================================
// 4. TRAÇABILITÉ DES CALLBACKS
// ==========================================
const callbackLogs = [];

async function saveCallbackLog(entry) {
    callbackLogs.unshift(entry);

    if (callbackLogs.length > 200) {
        callbackLogs.pop();
    }

    // Ne pas afficher les en-têtes d'authentification.
    const safeEntry = {
        ...entry,
        headers: {
            'content-type': entry.headers?.['content-type'] || null,
            'user-agent': entry.headers?.['user-agent'] || null
        }
    };

    console.log('\n📥 CALLBACK ENREGISTRÉ');
    console.log('Heure :', entry.receivedAt);
    console.log('Chemin :', entry.path);
    console.log('Méthode :', entry.method);
    console.log('IP :', entry.ip);
    console.log('Body :', JSON.stringify(entry.body, null, 2));

    try {
        await db.collection('ligdicash_callbacks').add({
            ...safeEntry,
            savedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.log('⚠️ Sauvegarde callback ignorée :', error.message);
    }
}

// ==========================================
// 5. HELPERS
// ==========================================
function extractCustom(custom, key) {
    if (!custom) return null;

    if (Array.isArray(custom)) {
        for (const item of custom) {
            if (
                item &&
                typeof item === 'object' &&
                item[key] !== undefined
            ) {
                return item[key];
            }
        }

        return null;
    }

    if (typeof custom === 'object') {
        return custom[key] ?? null;
    }

    return null;
}

function formatPhoneNumber(phone) {
    if (!phone || typeof phone !== 'string') return '';

    let cleaned = phone.replace(/[^\d+]/g, '');

    if (cleaned.startsWith('+')) {
        cleaned = cleaned.substring(1);
    }

    if (cleaned.startsWith('00')) {
        cleaned = cleaned.substring(2);
    }

    if (/^0[0-9]{7,8}$/.test(cleaned)) {
        cleaned = '223' + cleaned.substring(1);
    }

    return cleaned;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getLigdiHeaders() {
    return {
        Apikey: API_KEY,
        Authorization: `Bearer ${API_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
    };
}

function validOrderId(orderId) {
    return typeof orderId === 'string' &&
        /^[a-zA-Z0-9_-]{5,120}$/.test(orderId);
}

// ==========================================
// 6. INITIER UN PAIEMENT
// Types : premium / library / group / donks
// ==========================================
app.post('/initiate-payment', async (req, res) => {
    const {
        amount,
        phone,
        description,
        orderId,
        uid,
        type,
        itemId
    } = req.body || {};

    console.log('\n💳 INITIATE PAYMENT');
    console.log('Type :', type);
    console.log('ItemId :', itemId || 'aucun');
    console.log('Montant :', amount);
    console.log('Téléphone :', phone);
    console.log('OrderId :', orderId);

    if (!amount || !phone || !orderId || !type) {
        return res.status(400).json({
            error: 'Données manquantes (amount, phone, orderId, type).'
        });
    }

    if (!validOrderId(orderId)) {
        return res.status(400).json({
            error: 'Identifiant de commande invalide.'
        });
    }

    const amountNum = Number(amount);

    if (!Number.isSafeInteger(amountNum) || amountNum < MIN_AMOUNT) {
        return res.status(400).json({
            error: `Montant minimum : ${MIN_AMOUNT} FCFA`,
            minimum: MIN_AMOUNT
        });
    }

    const formattedPhone = formatPhoneNumber(phone);

    if (!/^[0-9]{10,15}$/.test(formattedPhone)) {
        return res.status(400).json({
            error: 'Numéro de téléphone invalide.'
        });
    }

    try {
        let verifiedUid = uid || null;
        let sellerId = null;
        let productTitle = '';
        let productPrice = amountNum;
        let creditsToAdd = 0;

        // ------------------------------------------
        // RECHARGE DONKS : authentification Firebase
        // ------------------------------------------
        if (type === 'donks') {
            const authHeader = req.headers.authorization || '';
            const match = authHeader.match(/^Bearer\s+(.+)$/i);

            if (!match) {
                return res.status(401).json({
                    error: 'Connexion requise pour recharger le portefeuille.'
                });
            }

            let decodedToken;

            try {
                decodedToken = await admin.auth().verifyIdToken(match[1]);
            } catch (error) {
                return res.status(401).json({
                    error: 'Session Firebase invalide ou expirée.'
                });
            }

            // Le UID vient du token vérifié, pas du navigateur.
            verifiedUid = decodedToken.uid;

            if (!DONKS_PACKS.includes(amountNum)) {
                return res.status(400).json({
                    error: 'Pack de recharge invalide.',
                    allowedPacks: DONKS_PACKS
                });
            }

            // 1 FCFA = 1 Donk.
            creditsToAdd = amountNum;
            productTitle = `${creditsToAdd} Donks`;
            productPrice = amountNum;
        } else {
            if (!verifiedUid) {
                return res.status(400).json({
                    error: 'UID utilisateur manquant.'
                });
            }

            if (!['premium', 'library', 'group'].includes(type)) {
                return res.status(400).json({
                    error: 'Type de paiement non pris en charge.'
                });
            }

            if (type === 'library') {
                if (!itemId) {
                    return res.status(400).json({
                        error: 'Identifiant du produit manquant.'
                    });
                }

                const productSnap = await db
                    .collection('digital_products')
                    .doc(itemId)
                    .get();

                if (!productSnap.exists) {
                    return res.status(404).json({
                        error: 'Produit introuvable.'
                    });
                }

                const productData = productSnap.data();

                sellerId = productData.sellerId || null;
                productTitle = productData.title || '';
                productPrice = Number(productData.price || 0);

                if (
                    !Number.isSafeInteger(productPrice) ||
                    productPrice <= 0 ||
                    productPrice !== amountNum
                ) {
                    return res.status(400).json({
                        error: 'Le montant ne correspond pas au prix du produit.'
                    });
                }
            }

            if (type === 'group') {
                if (!itemId) {
                    return res.status(400).json({
                        error: 'Identifiant du groupe manquant.'
                    });
                }

                const groupSnap = await db
                    .collection('groups')
                    .doc(itemId)
                    .get();

                if (!groupSnap.exists) {
                    return res.status(404).json({
                        error: 'Groupe introuvable.'
                    });
                }

                const groupData = groupSnap.data();

                sellerId = groupData.teacherId || null;
                productTitle = groupData.title || '';
                productPrice = Number(groupData.priceYearly || 0);

                if (
                    !Number.isSafeInteger(productPrice) ||
                    productPrice <= 0 ||
                    productPrice !== amountNum
                ) {
                    return res.status(400).json({
                        error: 'Le montant ne correspond pas au prix du groupe.'
                    });
                }
            }
        }

        // Éviter de réutiliser une commande existante.
        const purchaseRef = db.collection('purchases').doc(orderId);
        const existingPurchase = await purchaseRef.get();

        if (existingPurchase.exists) {
            return res.status(409).json({
                error: 'Cette commande existe déjà.',
                orderId
            });
        }

        const start = new Date();
        const oneYear = 365 * 24 * 60 * 60 * 1000;

        const end = ['premium', 'group'].includes(type)
            ? new Date(start.getTime() + oneYear)
            : null;

        const payload = {
            commande: {
                invoice: {
                    items: [],
                    total_amount: amountNum,
                    devise: 'XOF',
                    description: description ||
                        (type === 'donks'
                            ? `Recharge ${creditsToAdd} Donks`
                            : 'Achat SmartEduAfrica'),
                    customer: formattedPhone,
                    customer_firstname: 'Client',
                    customer_lastname: 'SmartEdu',
                    customer_email: 'client@smarteduafrica.com',
                    external_id: orderId,
                    otp: ''
                },
                store: {
                    name: 'SmartEduAfrica',
                    website_url: 'https://smarteduafrica.com'
                },
                actions: {
                    cancel_url: '',
                    return_url: '',
                    callback_url: PAYMENT_CALLBACK_URL
                },
                custom_data: {
                    transaction_id: orderId,
                    user_uid: verifiedUid,
                    purchase_type: type,
                    item_id: itemId || ''
                }
            }
        };

        console.log('📤 Envoi de la facture à LigdiCash...');

        const response = await axios.post(
            `${LIGDI_BASE_URL}/pay/v01/redirect/checkout-invoice/create`,
            payload,
            {
                headers: getLigdiHeaders(),
                timeout: 30000
            }
        );

        const data = response.data;

        console.log('📥 Réponse LigdiCash :', JSON.stringify(data));

        if (data.response_code !== '00' || !data.token) {
            return res.status(502).json({
                error: 'LigdiCash n’a pas pu créer la facture.',
                details: data
            });
        }

        // Enregistrer la commande avant de transmettre le lien au client.
        await purchaseRef.create({
            uid: verifiedUid,
            phone: formattedPhone,
            type,
            itemId: itemId || null,
            sellerId,
            productTitle,
            productPrice,
            amount: amountNum,
            creditsToAdd,
            status: 'pending',
            token: data.token,
            orderId,
            startDate: admin.firestore.Timestamp.fromDate(start),
            endDate: end
                ? admin.firestore.Timestamp.fromDate(end)
                : null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`✅ Commande ${orderId} enregistrée pour ${verifiedUid}`);

        return res.json({
            ...data,
            orderId
        });
    } catch (error) {
        console.error(
            '❌ Erreur initialisation :',
            error.response?.data || error.message
        );

        if (error.code === 6 || error.code === 'already-exists') {
            return res.status(409).json({
                error: 'Cette commande existe déjà.'
            });
        }

        return res.status(500).json({
            error: 'Échec de l’initialisation du paiement.',
            details: error.response?.data || error.message
        });
    }
});

// ==========================================
// 7. WEBHOOK PAIEMENT
// ==========================================
app.post('/webhook', async (req, res) => {
    // Répondre rapidement à LigdiCash.
    res.status(200).send('OK');

    try {
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

        const body = req.body || {};

        const orderId =
            extractCustom(body.custom_data, 'transaction_id') ||
            body.external_id;

        if (!orderId) {
            console.log('⚠️ OrderId introuvable dans le webhook.');
            return;
        }

        const payRef = db.collection('purchases').doc(String(orderId));
        const snap = await payRef.get();

        if (!snap.exists) {
            console.log('⚠️ Achat inconnu :', orderId);
            return;
        }

        const pay = snap.data();

        if (pay.status === 'completed') {
            console.log('ℹ️ Paiement déjà traité :', orderId);
            return;
        }

        if (!pay.token) {
            console.log('⚠️ Token LigdiCash absent :', orderId);
            return;
        }

        // Vérification indépendante auprès de LigdiCash.
        const confirm = await axios.get(
            `${LIGDI_BASE_URL}/pay/v01/redirect/checkout-invoice/confirm/?invoiceToken=${encodeURIComponent(pay.token)}`,
            {
                headers: getLigdiHeaders(),
                timeout: 30000
            }
        );

        console.log('✅ Confirmation LigdiCash :', JSON.stringify(confirm.data));

        const status = String(confirm.data.status || '').toLowerCase();

        if (status !== 'completed') {
            if (status === 'notcompleted' || status === 'failed') {
                await payRef.update({
                    status: 'notcompleted',
                    lastPaymentCheckAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }

            console.log(`⏳ Paiement ${orderId} : statut ${status || 'inconnu'}`);
            return;
        }

        // ------------------------------------------
        // RECHARGE DONKS : transaction atomique
        // ------------------------------------------
        if (pay.type === 'donks') {
            const credits = Number(pay.creditsToAdd);

            if (
                !Number.isSafeInteger(credits) ||
                credits <= 0 ||
                !DONKS_PACKS.includes(Number(pay.amount)) ||
                credits !== Number(pay.amount)
            ) {
                console.error('❌ Recharge Donks invalide :', orderId);
                return;
            }

            const purchaseRef = payRef;
            const walletRef = db
                .collection('users')
                .doc(pay.uid)
                .collection('wallet')
                .doc('main');

            await db.runTransaction(async transaction => {
                // Toutes les lectures avant les écritures.
                const currentPurchase = await transaction.get(purchaseRef);
                const walletSnap = await transaction.get(walletRef);

                if (!currentPurchase.exists) {
                    throw new Error('Commande introuvable pendant la transaction.');
                }

                const currentPay = currentPurchase.data();

                // Empêche le double crédit en cas de webhook répété.
                if (
                    currentPay.status === 'completed' ||
                    currentPay.creditApplied === true
                ) {
                    return;
                }

                const currentCredits = walletSnap.exists
                    ? Number(walletSnap.data().credits || 0)
                    : 0;

                if (!Number.isFinite(currentCredits) || currentCredits < 0) {
                    throw new Error('Solde de portefeuille invalide.');
                }

                transaction.set(walletRef, {
                    credits: currentCredits + credits,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                transaction.update(purchaseRef, {
                    status: 'completed',
                    creditApplied: true,
                    creditsAdded: credits,
                    confirmedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            console.log(`🎉 Recharge traitée : ${credits} Donks — ${orderId}`);
            return;
        }

        // ------------------------------------------
        // AUTRES TYPES : Premium, groupes, bibliothèque
        // ------------------------------------------
        if (pay.type === 'premium') {
            await db.runTransaction(async transaction => {
                const currentSnap = await transaction.get(payRef);

                if (
                    !currentSnap.exists ||
                    currentSnap.data().status === 'completed'
                ) {
                    return;
                }

                transaction.update(payRef, {
                    status: 'completed',
                    confirmedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                transaction.set(
                    db.collection('users').doc(pay.uid),
                    {
                        isPremium: true,
                        premiumStartDate: pay.startDate,
                        premiumEndDate: pay.endDate,
                        premiumOrderId: orderId
                    },
                    { merge: true }
                );
            });

            console.log(`🎉 PREMIUM ACTIVÉ pour ${pay.uid}`);
            return;
        }

        if (pay.type === 'group' && pay.itemId) {
            const memberQuery = await db.collection('group_members')
                .where('purchaseId', '==', orderId)
                .limit(1)
                .get();

            await db.runTransaction(async transaction => {
                const currentSnap = await transaction.get(payRef);

                if (
                    !currentSnap.exists ||
                    currentSnap.data().status === 'completed'
                ) {
                    return;
                }

                transaction.update(payRef, {
                    status: 'completed',
                    confirmedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                if (memberQuery.empty) {
                    const memberRef = db.collection('group_members').doc();

                    transaction.set(memberRef, {
                        groupId: pay.itemId,
                        userId: pay.uid,
                        status: 'active',
                        purchaseId: orderId,
                        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
                        expiresAt: pay.endDate,
                        paymentAmount: pay.amount
                    });

                    transaction.set(
                        db.collection('groups').doc(pay.itemId),
                        {
                            membersCount: admin.firestore.FieldValue.increment(1)
                        },
                        { merge: true }
                    );
                }
            });

            console.log(`🎉 Paiement du groupe traité : ${pay.itemId}`);
            return;
        }

        if (pay.type === 'library') {
            await payRef.update({
                status: 'completed',
                confirmedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log(`🎉 ACHAT BIBLIOTHÈQUE VALIDÉ : ${pay.itemId}`);
            return;
        }

        // Conserver le comportement des types non standards.
        await payRef.update({
            status: 'completed',
            confirmedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`🎉 ACHAT VALIDÉ (${pay.type}) : ${pay.itemId || ''}`);
    } catch (error) {
        console.error('❌ Erreur webhook paiement :', error.response?.data || error.message);
    }
});

// ==========================================
// 8. ROUTES CALLBACK DE TRAÇABILITÉ
// ==========================================
const CALLBACK_PATHS = [
    '/callback',
    '/callback/ligdicash',
    '/ligdicash/callback',
    '/callback/payment',
    '/payment/callback',
    '/webhook/callback'
];

app.all(CALLBACK_PATHS, async (req, res) => {
    res.status(200).json({
        status: 'ok',
        received: true,
        timestamp: new Date().toISOString(),
        path: req.originalUrl
    });

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
});

// ==========================================
// 9. CONSULTATION DES LOGS
// ==========================================
app.get('/callbacks', (req, res) => {
    if (
        !CALLBACK_VIEW_TOKEN ||
        req.query.token !== CALLBACK_VIEW_TOKEN
    ) {
        return res.status(403).json({
            error: 'Token invalide.'
        });
    }

    const requestedLimit = parseInt(req.query.limit || '20', 10);
    const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(requestedLimit, 200))
        : 20;

    const orderId = req.query.order_id || req.query.orderId;
    const source = req.query.source;

    let list = callbackLogs;

    if (orderId) {
        list = list.filter(log =>
            JSON.stringify(log).includes(String(orderId))
        );
    }

    if (source) {
        list = list.filter(log => log.source === source);
    }

    res.json({
        count: list.length,
        callbacks: list.slice(0, limit),
        serverTime: new Date().toISOString()
    });
});

// ==========================================
// 10. LIEN DE PAIEMENT DE TEST
// ==========================================
app.post('/test/payment-link', async (req, res) => {
    const {
        phone,
        amount = 10,
        description = 'Test de validation LigdiCash'
    } = req.body || {};

    if (!phone) {
        return res.status(400).json({
            error: 'Téléphone requis.'
        });
    }

    const amountNum = Number(amount);

    if (!Number.isSafeInteger(amountNum) || amountNum < MIN_AMOUNT) {
        return res.status(400).json({
            error: `Montant minimum : ${MIN_AMOUNT} FCFA`
        });
    }

    const formattedPhone = formatPhoneNumber(phone);

    if (!/^[0-9]{10,15}$/.test(formattedPhone)) {
        return res.status(400).json({
            error: 'Numéro de téléphone invalide.'
        });
    }

    const orderId = 'TEST-' + Date.now();

    try {
        const payload = {
            commande: {
                invoice: {
                    items: [],
                    total_amount: amountNum,
                    devise: 'XOF',
                    description,
                    customer: formattedPhone,
                    customer_firstname: 'Test',
                    customer_lastname: 'Validation',
                    customer_email: 'test@smarteduafrica.com',
                    external_id: orderId,
                    otp: ''
                },
                store: {
                    name: 'SmartEduAfrica Test',
                    website_url: 'https://smarteduafrica.com'
                },
                actions: {
                    cancel_url: '',
                    return_url: '',
                    callback_url: PAYMENT_CALLBACK_URL
                },
                custom_data: {
                    transaction_id: orderId,
                    user_uid: 'test-validation',
                    purchase_type: 'test',
                    item_id: 'test'
                }
            }
        };

        const response = await axios.post(
            `${LIGDI_BASE_URL}/pay/v01/redirect/checkout-invoice/create`,
            payload,
            {
                headers: getLigdiHeaders(),
                timeout: 30000
            }
        );

        const data = response.data;

        if (data.response_code === '00' && data.token) {
            await db.collection('purchases').doc(orderId).create({
                uid: 'test-validation',
                phone: formattedPhone,
                type: 'test',
                itemId: 'test',
                sellerId: null,
                productTitle: 'Test validation',
                productPrice: amountNum,
                amount: amountNum,
                status: 'pending',
                token: data.token,
                orderId,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        res.json({
            orderId,
            amount: amountNum,
            ...data,
            message: 'Lien de paiement généré.'
        });
    } catch (error) {
        console.error('❌ Erreur test :', error.response?.data || error.message);

        res.status(500).json({
            error: 'Erreur lors du test.',
            details: error.response?.data || error.message
        });
    }
});

// ==========================================
// 11. RETRAIT MARCHAND
// ==========================================
app.post('/process-withdrawal', async (req, res) => {
    const {
        sellerId,
        amount,
        phone,
        provider,
        sellerName,
        source
    } = req.body || {};

    const withdrawalSource = source || 'library';
    const amountNum = Number(amount);

    if (!sellerId || !amount || !phone) {
        return res.status(400).json({
            success: false,
            error: 'Données manquantes (sellerId, amount, phone requis).'
        });
    }

    if (!Number.isSafeInteger(amountNum) || amountNum <= 0) {
        return res.status(400).json({
            success: false,
            error: 'Le montant doit être un entier supérieur à 0.'
        });
    }

    const formattedPhone = formatPhoneNumber(phone);

    if (!/^[0-9]{10,15}$/.test(formattedPhone)) {
        return res.status(400).json({
            success: false,
            error: `Numéro invalide : ${formattedPhone}. Format attendu : 223XXXXXXXX`
        });
    }

    const withdrawalRef = db.collection('withdrawal_requests').doc();

    try {
        let totalRevenue = 0;

        if (withdrawalSource === 'groups') {
            const groupsSnap = await db.collection('groups')
                .where('teacherId', '==', sellerId)
                .get();

            for (const groupDoc of groupsSnap.docs) {
                const groupData = groupDoc.data();

                const salesSnap = await db.collection('purchases')
                    .where('itemId', '==', groupDoc.id)
                    .where('type', '==', 'group')
                    .where('status', '==', 'completed')
                    .get();

                totalRevenue += salesSnap.size *
                    Number(groupData.priceYearly || 0) * 0.80;
            }
        } else {
            const productsSnap = await db.collection('digital_products')
                .where('sellerId', '==', sellerId)
                .get();

            const myProductIds = new Set(
                productsSnap.docs.map(doc => doc.id)
            );

            const salesSnap = await db.collection('purchases')
                .where('type', '==', 'library')
                .where('status', '==', 'completed')
                .get();

            for (const sale of salesSnap.docs) {
                const data = sale.data();

                if (
                    myProductIds.has(data.itemId) ||
                    data.sellerId === sellerId
                ) {
                    totalRevenue += Number(data.productPrice || 0) * 0.80;
                }
            }
        }

        let withdrawn = 0;

        const paidSnap = await db.collection('withdrawal_requests')
            .where('sellerId', '==', sellerId)
            .where('status', '==', 'paid')
            .get();

        for (const doc of paidSnap.docs) {
            const data = doc.data();

            if (!data.source || data.source === withdrawalSource) {
                withdrawn += Number(data.netAmount || 0);
            }
        }

        let pending = 0;

        const pendingSnap = await db.collection('withdrawal_requests')
            .where('sellerId', '==', sellerId)
            .where('status', 'in', ['pending', 'processing', 'approved'])
            .get();

        for (const doc of pendingSnap.docs) {
            const data = doc.data();

            if (!data.source || data.source === withdrawalSource) {
                pending += Number(data.amount || 0);
            }
        }

        const availableBalance = Math.max(
            0,
            totalRevenue - withdrawn - pending
        );

        if (amountNum > availableBalance) {
            return res.status(400).json({
                success: false,
                error: `Solde insuffisant. Disponible : ${Math.floor(availableBalance)} FCFA`,
                availableBalance: Math.floor(availableBalance)
            });
        }

        const fee = Math.round(amountNum * 0.05);
        const netAmount = amountNum - fee;

        await withdrawalRef.create({
            sellerId,
            sellerName: sellerName || '',
            sellerPhone: phone,
            sellerPhoneFormatted: formattedPhone,
            mobileMoneyProvider: provider || 'auto',
            amount: amountNum,
            fee,
            netAmount,
            status: 'processing',
            source: withdrawalSource,
            createdAt: new Date().toISOString(),
            processedAt: new Date().toISOString(),
            paidAt: null,
            failedAt: null,
            failureReason: null,
            retryCount: 0
        });

        const payload = {
            commande: {
                amount: netAmount,
                description: `Retrait SmartEdu ${withdrawalRef.id.substring(0, 8)}`,
                customer: formattedPhone,
                callback_url: WITHDRAWAL_CALLBACK_URL,
                custom_data: {
                    transaction_id: `WITHDRAW-${withdrawalRef.id}`
                }
            }
        };

        let payoutResponse = null;
        let lastError = null;
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await axios.post(
                    `${LIGDI_BASE_URL}/pay/v01/straight/payout`,
                    payload,
                    {
                        headers: getLigdiHeaders(),
                        timeout: 30000
                    }
                );

                payoutResponse = response.data;

                if (payoutResponse.response_code === '00') break;

                if (
                    payoutResponse.response_code === '09' &&
                    attempt < maxRetries
                ) {
                    await delay(2000);
                } else {
                    break;
                }
            } catch (error) {
                lastError = error;

                if (attempt < maxRetries) {
                    await delay(2000);
                }
            }
        }

        if (!payoutResponse && lastError) {
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: `Erreur réseau : ${lastError.message}`,
                retryCount: maxRetries
            });

            return res.status(500).json({
                success: false,
                error: 'Erreur de connexion. Vérifiez le statut avant de réessayer.',
                withdrawalId: withdrawalRef.id
            });
        }

        if (!payoutResponse) {
            return res.status(502).json({
                success: false,
                error: 'Réponse LigdiCash indisponible.',
                withdrawalId: withdrawalRef.id
            });
        }

        if (payoutResponse.response_code === '00') {
            await withdrawalRef.update({
                status: 'processing',
                ligdiCashTransactionId: payoutResponse.token || null,
                ligdiCashResponse: payoutResponse,
                initiatedAt: new Date().toISOString()
            });

            return res.json({
                success: true,
                message: `Retrait de ${netAmount} FCFA initié.`,
                withdrawalId: withdrawalRef.id,
                transactionId: payoutResponse.token || null,
                netAmount,
                fee,
                status: 'processing'
            });
        }

        const errorReason =
            payoutResponse.response_text ||
            payoutResponse.description ||
            payoutResponse.message ||
            `Code : ${payoutResponse.response_code}`;

        const shouldFallback =
            payoutResponse.response_code === '14' ||
            payoutResponse.response_code === '09';

        if (shouldFallback) {
            await withdrawalRef.update({
                status: 'pending',
                failedAt: new Date().toISOString(),
                failureReason: errorReason,
                ligdiCashResponse: payoutResponse,
                responseCode: payoutResponse.response_code,
                retryCount: maxRetries,
                manualApprovalRequired: true,
                autoAttemptedAt: new Date().toISOString()
            });

            return res.status(200).json({
                success: true,
                message: 'Demande enregistrée pour traitement manuel.',
                withdrawalId: withdrawalRef.id,
                netAmount,
                fee,
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
    } catch (error) {
        console.error('❌ ERREUR RETRAIT :', error.message);

        try {
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: 'Erreur serveur : ' + error.message
            });
        } catch (updateError) {
            console.error('Erreur mise à jour retrait :', updateError.message);
        }

        return res.status(500).json({
            success: false,
            error: 'Erreur serveur.',
            details: error.message,
            withdrawalId: withdrawalRef.id
        });
    }
});

// ==========================================
// 12. WEBHOOK RETRAIT
// ==========================================
app.post('/webhook-withdrawal', async (req, res) => {
    res.status(200).send('OK');

    try {
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

        const body = req.body || {};

        let withdrawalId =
            extractCustom(body.custom_data, 'withdrawal_id');

        const transactionId =
            extractCustom(body.custom_data, 'transaction_id');

        if (
            !withdrawalId &&
            transactionId &&
            String(transactionId).startsWith('WITHDRAW-')
        ) {
            withdrawalId = String(transactionId).replace('WITHDRAW-', '');
        }

        if (!withdrawalId && body.external_id) {
            withdrawalId = String(body.external_id).replace('WITHDRAW-', '');
        }

        if (!withdrawalId) {
            console.log('⚠️ Identifiant du retrait introuvable.');
            return;
        }

        const withdrawalRef = db
            .collection('withdrawal_requests')
            .doc(String(withdrawalId));

        const snap = await withdrawalRef.get();

        if (!snap.exists) {
            console.log('⚠️ Retrait inconnu :', withdrawalId);
            return;
        }

        const currentData = snap.data();
        const status = String(body.status || '').toLowerCase();
        const responseCode = String(body.response_code || '');

        if (
            status === 'completed' ||
            status === 'success' ||
            responseCode === '00'
        ) {
            if (currentData.status !== 'paid') {
                await withdrawalRef.update({
                    status: 'paid',
                    paidAt: new Date().toISOString(),
                    ligdiCashWebhookResponse: body
                });

                console.log(`✅ Retrait ${withdrawalId} PAYÉ`);
            }
        } else if (status === 'pending' || status === 'processing') {
            console.log(`⏳ Retrait ${withdrawalId} en cours`);
        } else if (
            ['failed', 'error', 'cancelled', 'notcompleted'].includes(status)
        ) {
            const failureReason =
                body.response_text ||
                body.message ||
                'Erreur LigdiCash';

            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason,
                ligdiCashWebhookResponse: body
            });

            console.log(`❌ Retrait ${withdrawalId} échoué : ${failureReason}`);
        }
    } catch (error) {
        console.error('❌ Erreur webhook retrait :', error.message);
    }
});

// ==========================================
// 13. ROUTE DE SANTÉ
// ==========================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'LigdiCash SmartEduAfrica API',
        version: '6.0 - Donks Wallet',
        endpoints: [
            'POST /initiate-payment (premium/library/group/donks)',
            'POST /webhook',
            'POST /webhook-withdrawal',
            'POST /process-withdrawal',
            'POST /test/payment-link',
            'GET /callbacks?token=...',
            'ALL /callback, /callback/ligdicash, etc.'
        ],
        config: {
            minAmount: `${MIN_AMOUNT} FCFA`,
            donksPacks: DONKS_PACKS,
            callbackViewEnabled: Boolean(CALLBACK_VIEW_TOKEN),
            firestoreLogs: true
        },
        timestamp: new Date().toISOString()
    });
});

// ==========================================
// 14. DÉMARRAGE
// ==========================================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  🚀 LigdiCash SmartEduAfrica v6.0            ║');
    console.log(`║  Port : ${PORT}`);
    console.log(`║  MIN_AMOUNT : ${MIN_AMOUNT} FCFA`);
    console.log('║  Recharge Donks activée                      ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log('POST /initiate-payment');
    console.log('POST /webhook');
    console.log('POST /process-withdrawal');
    console.log('POST /webhook-withdrawal');
    console.log('POST /test/payment-link');
    console.log('GET  /callbacks');
    console.log('');
});
