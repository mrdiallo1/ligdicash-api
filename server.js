
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');

// ==========================================
// 1. CONNEXION FIREBASE
// ==========================================

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT est manquant.');
}

admin.initializeApp({
    credential: admin.credential.cert(
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    )
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

const MIN_AMOUNT = Number(process.env.MIN_AMOUNT || 10);
const CALLBACK_VIEW_TOKEN = process.env.CALLBACK_VIEW_TOKEN;

const BASE = 'https://app.ligdicash.com';

const PUBLIC_URL = (
    process.env.PUBLIC_URL ||
    'https://ligdicash-api.onrender.com'
).replace(/\/$/, '');

const PAYMENT_CALLBACK_URL = `${PUBLIC_URL}/webhook`;

const WITHDRAWAL_CALLBACK_URL =
    `${PUBLIC_URL}/webhook-withdrawal`;

if (!Number.isSafeInteger(MIN_AMOUNT) || MIN_AMOUNT < 1) {
    throw new Error('MIN_AMOUNT invalide.');
}

if (!API_KEY || !API_TOKEN) {
    throw new Error('Clés LigdiCash manquantes.');
}

const callbackLogs = [];

const stamp = () =>
    admin.firestore.FieldValue.serverTimestamp();

const headers = () => ({
    Apikey: API_KEY,
    Authorization: `Bearer ${API_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
});

// ==========================================
// 4. FONCTIONS UTILITAIRES
// ==========================================

const validOrderId = id =>
    typeof id === 'string' &&
    /^[a-zA-Z0-9_-]{5,120}$/.test(id);

function extractCustom(custom, key) {
    if (Array.isArray(custom)) {
        return custom.find(
            x =>
                x &&
                typeof x === 'object' &&
                x[key] !== undefined
        )?.[key] ?? null;
    }

    return custom && typeof custom === 'object'
        ? custom[key] ?? null
        : null;
}

function formatPhoneNumber(phone) {
    let p = String(phone || '').replace(/\D/g, '');

    if (p.startsWith('00223')) {
        p = p.slice(2);
    }

    if (/^\d{8}$/.test(p)) {
        p = '223' + p;
    }

    return p;
}

async function saveCallbackLog(entry) {
    const safe = {
        ...entry,
        headers: {
            'content-type':
                entry.headers?.['content-type'] || null,
            'user-agent':
                entry.headers?.['user-agent'] || null
        }
    };

    callbackLogs.unshift(safe);

    if (callbackLogs.length > 200) {
        callbackLogs.pop();
    }

    try {
        await db.collection('ligdicash_callbacks').add({
            ...safe,
            savedAt: stamp()
        });
    } catch (e) {
        console.error('Sauvegarde callback :', e.message);
    }
}

// ==========================================
// 5. EXTRACTION DU LIEN LIGDICASH
// ==========================================

function paymentUrl(data) {
    const candidates = [
        data?.response_text,
        data?.payment_url,
        data?.paymentUrl,
        data?.redirect_url,
        data?.redirectUrl,
        data?.url,
        data?.data?.response_text,
        data?.data?.payment_url,
        data?.data?.paymentUrl,
        data?.data?.redirect_url,
        data?.data?.url,
        data?.response?.response_text
    ];

    for (const value of candidates) {
        if (typeof value !== 'string') {
            continue;
        }

        try {
            const parsed = new URL(value);

            if (
                parsed.protocol === 'https:' ||
                parsed.protocol === 'http:'
            ) {
                return parsed.href;
            }
        } catch {
            // La valeur ne correspond pas à une URL valide.
        }
    }

    return null;
}

// ==========================================
// 6. CONSTRUCTION DE LA FACTURE
// ==========================================

function invoicePayload({
    amount,
    phone,
    description,
    orderId,
    uid,
    type,
    itemId = '',
    callback = PAYMENT_CALLBACK_URL
}) {
    return {
        commande: {
            invoice: {
                items: [],
                total_amount: amount,
                devise: 'XOF',
                description,

                // Ne pas filtrer les moyens de paiement
                // à partir du numéro du client.
                customer: '',

                customer_firstname: 'Client',
                customer_lastname: 'Donko',
                customer_email: 'client@smarteduafrica.com',
                external_id: orderId,
                otp: ''
            },

            store: {
                name: 'Donko',
                website_url: 'https://smarteduafrica.com'
            },

            actions: {
                cancel_url: '',
                return_url: '',
                callback_url: callback
            },

            custom_data: {
                transaction_id: orderId,
                user_uid: uid,
                purchase_type: type,
                item_id: itemId
            }
        }
    };
}

// ==========================================
// 7. CONFIRMATION DU PAIEMENT
// ==========================================

async function confirmPayment(token) {
    const response = await axios.get(
        `${BASE}/pay/v01/redirect/checkout-invoice/confirm/?invoiceToken=${encodeURIComponent(token)}`,
        {
            headers: headers(),
            timeout: 30000
        }
    );

    return response.data;
}

// ==========================================
// 8. INITIER UN PAIEMENT
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

    const amountNum = Number(amount);

    if (
        !phone ||
        !orderId ||
        !type ||
        amount === undefined ||
        amount === null ||
        amount === ''
    ) {
        return res.status(400).json({
            error:
                'Données manquantes (amount, phone, orderId, type).'
        });
    }

    if (!validOrderId(orderId)) {
        return res.status(400).json({
            error: 'Identifiant de commande invalide.'
        });
    }

    // Montant libre, sans restriction de packs.
    if (
        !Number.isSafeInteger(amountNum) ||
        amountNum < MIN_AMOUNT
    ) {
        return res.status(400).json({
            error: `Montant minimum : ${MIN_AMOUNT} FCFA`,
            minimum: MIN_AMOUNT
        });
    }

    const formattedPhone = formatPhoneNumber(phone);

    if (!/^223\d{8}$/.test(formattedPhone)) {
        return res.status(400).json({
            error: 'Numéro malien invalide.'
        });
    }

    if (
        !['donks', 'premium', 'library', 'group'].includes(type)
    ) {
        return res.status(400).json({
            error: 'Type de paiement non pris en charge.'
        });
    }

    try {
        let verifiedUid = uid || null;
        let sellerId = null;
        let productTitle = '';
        let productPrice = amountNum;
        let creditsToAdd = 0;

        // ==================================
        // RECHARGE DONKS
        // ==================================

        if (type === 'donks') {
            const match = (
                req.headers.authorization || ''
            ).match(/^Bearer\s+(.+)$/i);

            if (!match) {
                return res.status(401).json({
                    error: 'Connexion requise pour recharger.'
                });
            }

            let decoded;

            try {
                decoded = await admin.auth().verifyIdToken(match[1]);
            } catch {
                return res.status(401).json({
                    error: 'Session Firebase invalide ou expirée.'
                });
            }

            // UID récupéré depuis Firebase.
            verifiedUid = decoded.uid;

            // 1 FCFA = 1 Donk.
            creditsToAdd = amountNum;
            productTitle = `${creditsToAdd} Donks`;

        } else {
            if (
                !verifiedUid ||
                typeof verifiedUid !== 'string'
            ) {
                return res.status(400).json({
                    error: 'UID utilisateur manquant.'
                });
            }

            if (type === 'library' || type === 'group') {
                if (!itemId || typeof itemId !== 'string') {
                    return res.status(400).json({
                        error:
                            'Identifiant du produit/groupe manquant.'
                    });
                }

                const snap = await db
                    .collection(
                        type === 'library'
                            ? 'digital_products'
                            : 'groups'
                    )
                    .doc(itemId)
                    .get();

                if (!snap.exists) {
                    return res.status(404).json({
                        error: 'Produit ou groupe introuvable.'
                    });
                }

                const data = snap.data();

                sellerId = type === 'library'
                    ? data.sellerId || null
                    : data.teacherId || null;

                productTitle = data.title || '';

                productPrice = Number(
                    type === 'library'
                        ? data.price
                        : data.priceYearly
                );

                if (
                    !Number.isSafeInteger(productPrice) ||
                    productPrice <= 0 ||
                    productPrice !== amountNum
                ) {
                    return res.status(400).json({
                        error:
                            'Le montant ne correspond pas au prix du produit ou groupe.'
                    });
                }
            }
        }

        // ==================================
        // ENREGISTREMENT DE LA COMMANDE
        // ==================================

        const purchaseRef = db
            .collection('purchases')
            .doc(orderId);

        try {
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
                status: 'initiating',
                orderId,
                createdAt: stamp()
            });
        } catch (e) {
            if (
                e.code === 6 ||
                e.code === 'already-exists'
            ) {
                return res.status(409).json({
                    error: 'Cette commande existe déjà.',
                    orderId
                });
            }

            throw e;
        }

        const start = new Date();

        const end = ['premium', 'group'].includes(type)
            ? new Date(start.getTime() + 365 * 86400000)
            : null;

        // ==================================
        // APPEL API LIGDICASH
        // ==================================

        try {
            const response = await axios.post(
                `${BASE}/pay/v01/redirect/checkout-invoice/create`,
                invoicePayload({
                    amount: amountNum,
                    phone: formattedPhone,
                    description:
                        description ||
                        (
                            type === 'donks'
                                ? `Recharge ${creditsToAdd} Donks`
                                : 'Achat Donko'
                        ),
                    orderId,
                    uid: verifiedUid,
                    type,
                    itemId
                }),
                {
                    headers: headers(),
                    timeout: 30000
                }
            );

            const data = response.data;
            const url = paymentUrl(data);

            if (
                String(data?.response_code) !== '00' ||
                !data?.token ||
                !url
            ) {
                await purchaseRef.update({
                    status: 'initiation_failed',
                    initiationResponseCode:
                        String(data?.response_code || ''),
                    updatedAt: stamp()
                });

                return res.status(502).json({
                    error:
                        'LigdiCash n’a pas fourni une facture et un lien de paiement valides.',
                    responseCode: data?.response_code || null
                });
            }

            await purchaseRef.update({
                status: 'pending',
                token: data.token,
                paymentUrl: url,
                startDate:
                    admin.firestore.Timestamp.fromDate(start),
                endDate: end
                    ? admin.firestore.Timestamp.fromDate(end)
                    : null,
                updatedAt: stamp()
            });

            // Les deux champs de lien sont conservés
            // pour la compatibilité avec le site de recharge.
            return res.json({
                response_code: '00',
                response_text: url,
                payment_url: url,
                token: data.token,
                orderId
            });

        } catch (e) {
            await purchaseRef.update({
                status: 'initiation_unknown',
                updatedAt: stamp(),
                initiationError: String(e.message).slice(0, 300)
            }).catch(() => {});

            console.error(
                'Initialisation LigdiCash :',
                e.response?.data || e.message
            );

            return res.status(502).json({
                error:
                    'Initialisation non confirmée. Vérifie cette commande avant de réessayer.',
                orderId
            });
        }

    } catch (e) {
        console.error('Initialisation :', e.message);

        return res.status(500).json({
            error: 'Échec de l’initialisation du paiement.'
        });
    }
});

// ==========================================
// 9. TRAITEMENT DU PAIEMENT CONFIRMÉ
// ==========================================

async function settlePayment(orderId) {
    if (!validOrderId(orderId)) {
        return { status: 'invalid' };
    }

    const payRef = db.collection('purchases').doc(orderId);
    const snap = await payRef.get();

    if (!snap.exists) {
        return { status: 'unknown' };
    }

    const pay = snap.data();

    if (pay.status === 'completed') {
        return { status: 'completed' };
    }

    if (!pay.token) {
        return { status: 'no_token' };
    }

    // Vérification indépendante auprès de LigdiCash.
    const confirmation = await confirmPayment(pay.token);

    const status = String(
        confirmation?.status || ''
    ).toLowerCase();

    if (status !== 'completed') {
        if (
            ['notcompleted', 'failed', 'cancelled'].includes(status)
        ) {
            await payRef.update({
                status: 'notcompleted',
                lastPaymentCheckAt: stamp()
            });
        }

        return { status: status || 'unknown' };
    }

    // ==================================
    // CRÉDITER LE PORTEFEUILLE DONKS
    // ==================================

    if (pay.type === 'donks') {
        const walletRef = db
            .collection('users')
            .doc(pay.uid)
            .collection('wallet')
            .doc('main');

        await db.runTransaction(async tx => {
            const current = await tx.get(payRef);
            const wallet = await tx.get(walletRef);

            if (!current.exists) {
                throw new Error('Commande absente.');
            }

            const p = current.data();

            // Protection contre le double crédit.
            if (
                p.status === 'completed' ||
                p.creditApplied === true
            ) {
                return;
            }

            const credits = Number(p.creditsToAdd);

            if (
                !Number.isSafeInteger(credits) ||
                credits < MIN_AMOUNT ||
                credits !== Number(p.amount)
            ) {
                throw new Error('Montant Donks incohérent.');
            }

            const balance = wallet.exists
                ? Number(wallet.data().credits || 0)
                : 0;

            if (
                !Number.isSafeInteger(balance) ||
                balance < 0 ||
                !Number.isSafeInteger(balance + credits)
            ) {
                throw new Error('Solde invalide.');
            }

            tx.set(
                walletRef,
                {
                    credits: balance + credits,
                    updatedAt: stamp()
                },
                { merge: true }
            );

            tx.update(payRef, {
                status: 'completed',
                creditApplied: true,
                creditsAdded: credits,
                confirmedAt: stamp()
            });
        });

    // ==================================
    // ABONNEMENT PREMIUM
    // ==================================

    } else if (pay.type === 'premium') {
        await db.runTransaction(async tx => {
            const current = await tx.get(payRef);

            if (
                !current.exists ||
                current.data().status === 'completed'
            ) {
                return;
            }

            tx.update(payRef, {
                status: 'completed',
                confirmedAt: stamp()
            });

            tx.set(
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

    // ==================================
    // ACHAT GROUPE
    // ==================================

    } else if (pay.type === 'group' && pay.itemId) {
        const memberRef = db.collection('group_members').doc(orderId);
        const groupRef = db.collection('groups').doc(pay.itemId);

        await db.runTransaction(async tx => {
            const current = await tx.get(payRef);
            const member = await tx.get(memberRef);

            if (
                !current.exists ||
                current.data().status === 'completed'
            ) {
                return;
            }

            if (!member.exists) {
                tx.set(memberRef, {
                    groupId: pay.itemId,
                    userId: pay.uid,
                    status: 'active',
                    purchaseId: orderId,
                    joinedAt: stamp(),
                    expiresAt: pay.endDate,
                    paymentAmount: pay.amount
                });

                tx.set(
                    groupRef,
                    {
                        membersCount:
                            admin.firestore.FieldValue.increment(1)
                    },
                    { merge: true }
                );
            }

            tx.update(payRef, {
                status: 'completed',
                confirmedAt: stamp()
            });
        });

    // ==================================
    // ACHAT BIBLIOTHÈQUE
    // ==================================

    } else if (pay.type === 'library') {
        await db.runTransaction(async tx => {
            const current = await tx.get(payRef);

            if (
                !current.exists ||
                current.data().status === 'completed'
            ) {
                return;
            }

            tx.update(payRef, {
                status: 'completed',
                confirmedAt: stamp()
            });
        });

    } else {
        // Les commandes de test ne donnent aucun droit ni crédit.
        await payRef.update({
            status: 'completed',
            confirmedAt: stamp()
        });
    }

    return { status: 'completed' };
}

// ==========================================
// 10. WEBHOOK PAIEMENT
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
            console.warn('Webhook sans orderId');
            return;
        }

        console.log(
            'Résultat webhook :',
            orderId,
            await settlePayment(String(orderId))
        );

    } catch (e) {
        console.error(
            'Webhook paiement :',
            e.response?.data || e.message
        );
    }
});

// ==========================================
// 11. CALLBACKS SUPPLÉMENTAIRES
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
// 12. CONSULTATION DES CALLBACKS
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

    const n = Number.parseInt(req.query.limit || '20', 10);
    let logs = callbackLogs;

    if (req.query.order_id || req.query.orderId) {
        logs = logs.filter(x =>
            JSON.stringify(x).includes(
                String(req.query.order_id || req.query.orderId)
            )
        );
    }

    if (req.query.source) {
        logs = logs.filter(x => x.source === req.query.source);
    }

    res.json({
        count: logs.length,
        callbacks: logs.slice(
            0,
            Number.isFinite(n)
                ? Math.max(1, Math.min(n, 200))
                : 20
        ),
        serverTime: new Date().toISOString()
    });
});

// ==========================================
// 13. TEST DU LIEN DE PAIEMENT
// ==========================================

app.post('/test/payment-link', async (req, res) => {
    const {
        phone,
        amount = 10,
        description = 'Test de validation LigdiCash'
    } = req.body || {};

    const amountNum = Number(amount);
    const formattedPhone = formatPhoneNumber(phone);

    if (
        !Number.isSafeInteger(amountNum) ||
        amountNum < MIN_AMOUNT
    ) {
        return res.status(400).json({
            error: `Montant minimum : ${MIN_AMOUNT} FCFA`
        });
    }

    if (!/^223\d{8}$/.test(formattedPhone)) {
        return res.status(400).json({
            error: 'Numéro malien invalide.'
        });
    }

    const orderId = `TEST-${Date.now()}`;

    try {
        const response = await axios.post(
            `${BASE}/pay/v01/redirect/checkout-invoice/create`,
            invoicePayload({
                amount: amountNum,
                phone: formattedPhone,
                description,
                orderId,
                uid: 'test-validation',
                type: 'test',
                itemId: 'test'
            }),
            {
                headers: headers(),
                timeout: 30000
            }
        );

        const data = response.data;
        const url = paymentUrl(data);

        if (
            String(data?.response_code) !== '00' ||
            !data?.token ||
            !url
        ) {
            return res.status(502).json({
                error: 'Facture de test non créée.',
                responseCode: data?.response_code || null
            });
        }

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
            createdAt: stamp()
        });

        return res.json({
            orderId,
            amount: amountNum,
            response_code: '00',
            response_text: url,
            payment_url: url,
            token: data.token
        });

    } catch (e) {
        console.error(
            'Test :',
            e.response?.data || e.message
        );

        return res.status(502).json({
            error: 'Erreur lors du test.'
        });
    }
});

// ==========================================
// 14. RETRAITS MARCHANDS
// TEMPORAIREMENT DÉSACTIVÉS
// ==========================================

// L'ancienne route ne vérifiait pas
// l'identité du marchand demandeur.
// Elle doit être sécurisée avant réactivation.

app.post('/process-withdrawal', (req, res) => {
    return res.status(503).json({
        success: false,
        error:
            'Retraits temporairement indisponibles : contrôle marchand requis.'
    });
});

// ==========================================
// 15. WEBHOOK RETRAIT
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
    } catch (e) {
        console.error('Webhook retrait :', e.message);
    }

    // Ne jamais déclarer un retrait payé
    // sur la seule base d'un callback non vérifié.
});

// ==========================================
// 16. ROUTE DE SANTÉ
// ==========================================

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'LigdiCash Donko API',
        version: '7.0 - montant libre',

        endpoints: [
            'POST /initiate-payment',
            'POST /webhook',
            'POST /webhook-withdrawal',
            'POST /process-withdrawal (désactivé)',
            'POST /test/payment-link',
            'GET /callbacks?token=...'
        ],

        config: {
            minAmount: `${MIN_AMOUNT} FCFA`,
            donksRecharge: 'Montant libre',
            callbackViewEnabled: Boolean(CALLBACK_VIEW_TOKEN),
            firestoreLogs: true
        },

        timestamp: new Date().toISOString()
    });
});

// ==========================================
// 17. DÉMARRAGE
// ==========================================

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
    console.log(
        `Donko LigdiCash v7 - port ${PORT} - minimum ${MIN_AMOUNT} FCFA`
    );
});
