require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');

// ✅ Connexion Firestore
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.LIGDI_API_KEY;
const API_TOKEN = process.env.LIGDI_API_TOKEN;

// ==========================================
// HELPER : extrait une valeur de custom_data
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

// ==========================================
// ✅ HELPER : Formate un numéro au format LigdiCash
// Format attendu : indicatif + numéro, sans '+' ni espaces
// Exemple : "+226 70 00 00 00" → "22670000000"
// ==========================================
function formatPhoneNumber(phone) {
    if (!phone) return '';
    
    // Enlever tous les caractères non numériques sauf +
    let cleaned = phone.replace(/[^\d+]/g, '');
    
    // Enlever le '+' au début
    if (cleaned.startsWith('+')) {
        cleaned = cleaned.substring(1);
    }
    
    // Si le numéro commence par '00', le remplacer par rien
    if (cleaned.startsWith('00')) {
        cleaned = cleaned.substring(2);
    }
    
    // Si le numéro est local burkinabè (07...), ajouter 226
    if (/^0[0-9]{7,8}$/.test(cleaned)) {
        cleaned = '226' + cleaned.substring(1);
    }
    
    return cleaned;
}

// ==========================================
// ✅ HELPER : Délai (pour retry)
// ==========================================
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// 1. INITIER UN PAIEMENT (premium / library / group)
// ==========================================
app.post('/initiate-payment', async (req, res) => {
    const { amount, phone, description, orderId, uid, type, itemId } = req.body;

    if (!amount || !phone || !orderId || !uid || !type) {
        return res.status(400).json({ error: "Données manquantes (uid/type requis)" });
    }

    try {
        // ✅ Récupérer sellerId et infos produit pour les achats library
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

            await db.collection('purchases').doc(orderId).set({
                uid: uid,
                phone: phone,
                type: type,
                itemId: itemId || null,
                sellerId: sellerId,
                productTitle: productTitle,
                productPrice: productPrice,
                amount: parseInt(amount),
                status: 'pending',
                token: data.token,
                orderId: orderId,
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

// ==========================================
// 2. WEBHOOK PAIEMENT : valide le paiement + enregistre
// ==========================================
app.post('/webhook', async (req, res) => {
    console.log("🔔 WEBHOOK PAIEMENT REÇU:", JSON.stringify(req.body));
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
        console.error('❌ Erreur webhook paiement:', e.message);
    }
});

// ==========================================
// 3. ✅ RETRAIT - PAYOUT MARCHAND (CORRIGÉ CODE 09)
// ==========================================
// Documentation : https://developers.ligdicash.com/api-paiement/payout/vers-mobile-money
// Endpoint : POST /pay/v01/straight/payout
// Corrections Code 09 :
//   - Payload custom_data simplifié (uniquement transaction_id)
//   - Retry automatique (3 tentatives avec délai 2s)
//   - Validation regex du numéro
//   - Montant net arrondi (entier positif)
//   - Description courte (<50 chars)
// ==========================================
app.post('/process-withdrawal', async (req, res) => {
    const { 
        sellerId, 
        amount, 
        phone, 
        provider,
        sellerName 
    } = req.body;

    // ═══════════════════════════════════════════════
    // VALIDATION DES PARAMÈTRES
    // ═══════════════════════════════════════════════
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

    // ✅ Formater le numéro au format LigdiCash
    const formattedPhone = formatPhoneNumber(phone);
    
    // ✅ Validation du numéro formaté (regex)
    if (!/^[0-9]{10,15}$/.test(formattedPhone)) {
        return res.status(400).json({
            success: false,
            error: `Numéro invalide: ${formattedPhone}. Format attendu: 226XXXXXXXX`
        });
    }
    
    console.log(`\n💸 ═══════════════════════════════════════`);
    console.log(`   RETRAIT DEMANDÉ (Payout Marchand)`);
    console.log(`════════════════════════════════════════`);
    console.log(`   ├─ Vendeur: ${sellerId}`);
    console.log(`   ├─ Nom: ${sellerName || 'N/A'}`);
    console.log(`   ├─ Montant demandé: ${amount} FCFA`);
    console.log(`   ├─ Provider (info): ${provider || 'auto'}`);
    console.log(`   ├─ Numéro original: ${phone}`);
    console.log(`   └─ Numéro formaté: ${formattedPhone}`);
    console.log(`════════════════════════════════════════\n`);

    const withdrawalRef = db.collection('withdrawal_requests').doc();
    
    try {
        // ═══════════════════════════════════════════════
        // ÉTAPE 1 : VÉRIFIER LE SOLDE DU VENDEUR
        // ═══════════════════════════════════════════════
        console.log('🔍 ÉTAPE 1 : Vérification du solde...');
        
        const myProductIds = new Set();
        try {
            const productsSnap = await db.collection('digital_products')
                .where('sellerId', '==', sellerId)
                .get();
            
            for (const doc of productsSnap.docs) {
                myProductIds.add(doc.id);
            }
            console.log(`   📦 ${myProductIds.size} produits trouvés`);
        } catch (e) {
            console.log(`   ⚠️ Erreur produits: ${e.message}`);
        }
        
        // Calculer revenus totaux (80%)
        let totalRevenue = 0.0;
        
        try {
            const salesSnap = await db.collection('purchases')
                .where('sellerId', '==', sellerId)
                .where('status', '==', 'completed')
                .get();
            
            for (const sale of salesSnap.docs) {
                const data = sale.data();
                const price = data.productPrice || 0;
                totalRevenue += price * 0.80;
            }
            console.log(`   💰 Revenus via sellerId: ${totalRevenue.toFixed(2)} F`);
        } catch (e) {
            console.log(`   ⚠️ Erreur ventes sellerId: ${e.message}`);
        }
        
        // Fallback par itemId
        try {
            const allSales = await db.collection('purchases')
                .where('type', '==', 'library')
                .where('status', '==', 'completed')
                .get();
            
            let fallbackRevenue = 0.0;
            for (const sale of allSales.docs) {
                const data = sale.data();
                if (myProductIds.has(data.itemId) && data.sellerId !== sellerId) {
                    const price = data.productPrice || 0;
                    fallbackRevenue += price * 0.80;
                }
            }
            totalRevenue += fallbackRevenue;
            if (fallbackRevenue > 0) {
                console.log(`   💰 Revenus fallback: +${fallbackRevenue.toFixed(2)} F`);
            }
        } catch (e) {
            console.log(`   ⚠️ Erreur fallback: ${e.message}`);
        }
        
        // Déjà retiré
        let withdrawn = 0.0;
        try {
            const paidSnap = await db.collection('withdrawal_requests')
                .where('sellerId', '==', sellerId)
                .where('status', '==', 'paid')
                .get();
            
            for (const doc of paidSnap.docs) {
                withdrawn += doc.data().netAmount || 0;
            }
        } catch (e) {}
        
        // En attente
        let pending = 0.0;
        try {
            const pendingSnap = await db.collection('withdrawal_requests')
                .where('sellerId', '==', sellerId)
                .where('status', 'in', ['pending', 'processing', 'approved'])
                .get();
            
            for (const doc of pendingSnap.docs) {
                pending += doc.data().amount || 0;
            }
        } catch (e) {}
        
        const availableBalance = Math.max(0, totalRevenue - withdrawn - pending);
        
        console.log(`\n   📊 RÉSUMÉ SOLDE:`);
        console.log(`   ├─ Revenus totaux (80%): ${totalRevenue.toFixed(2)} F`);
        console.log(`   ├─ Déjà retiré: ${withdrawn.toFixed(2)} F`);
        console.log(`   ├─ En attente: ${pending.toFixed(2)} F`);
        console.log(`   ├─ ✅ Disponible: ${availableBalance.toFixed(2)} F`);
        console.log(`   └─ 💸 Demandé: ${amount} F\n`);
        
        if (amount > availableBalance) {
            console.log(`   ❌ REFUSÉ : Solde insuffisant\n`);
            return res.status(400).json({
                success: false,
                error: `Solde insuffisant. Disponible: ${Math.floor(availableBalance)} FCFA`,
                availableBalance: Math.floor(availableBalance)
            });
        }
        
        console.log(`   ✅ Solde suffisant, traitement autorisé\n`);
        
        // ═══════════════════════════════════════════════
        // ÉTAPE 2 : CALCULER LES FRAIS ET CRÉER LA DEMANDE
        // ═══════════════════════════════════════════════
        const fee = Math.round(amount * 0.05); // 5%
        const netAmount = Math.round(amount - fee); // ✅ ENTIER (pas de décimales)
        
        console.log('📝 ÉTAPE 2 : Création de la demande...');
        console.log(`   ├─ ID demande: ${withdrawalRef.id}`);
        console.log(`   ├─ Montant brut: ${amount} F`);
        console.log(`   ├─ Frais (5%): ${fee} F`);
        console.log(`   └─ Montant net: ${netAmount} F`);
        
        await withdrawalRef.set({
            sellerId: sellerId,
            sellerName: sellerName || '',
            sellerPhone: phone,
            sellerPhoneFormatted: formattedPhone,
            mobileMoneyProvider: provider || 'auto',
            amount: amount,
            fee: fee,
            netAmount: netAmount,
            status: 'processing',
            createdAt: new Date().toISOString(),
            processedAt: new Date().toISOString(),
            paidAt: null,
            failedAt: null,
            failureReason: null,
            retryCount: 0,
        });
        
        console.log(`   ✅ Demande créée en statut "processing"\n`);
        
        // ═══════════════════════════════════════════════
        // ÉTAPE 3 : APPELER LIGDICASH AVEC RETRY (3 tentatives)
        // ═══════════════════════════════════════════════
        console.log('📤 ÉTAPE 3 : Envoi à LigdiCash Payout...');
        console.log('   Endpoint: POST /pay/v01/straight/payout\n');
        
        // ✅ Payload SIMPLIFIÉ selon documentation officielle
        // custom_data contient UNIQUEMENT transaction_id (recommandé par LigdiCash)
        const payload = {
            commande: {
                amount: netAmount, // ✅ Entier positif
                description: `Retrait SmartEdu ${withdrawalRef.id.substring(0, 8)}`, // ✅ Court (<50 chars)
                customer: formattedPhone, // ✅ Format: 226XXXXXXXX
                callback_url: "https://ligdicash-api.onrender.com/webhook-withdrawal",
                custom_data: {
                    transaction_id: `WITHDRAW-${withdrawalRef.id}` // ✅ UNIQUEMENT transaction_id
                }
            }
        };
        
        console.log('   Payload envoyé:');
        console.log(JSON.stringify(payload, null, 2));
        console.log('');
        
        // ✅ RETRY AUTOMATIQUE (3 tentatives)
        let payoutResponse = null;
        let lastError = null;
        const maxRetries = 3;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            console.log(`   🔄 Tentative ${attempt}/${maxRetries}...`);
            
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
                console.log(`   ✅ Tentative ${attempt} réussie`);
                console.log('   Response:', JSON.stringify(payoutResponse, null, 2));
                
                // Si succès (response_code = "00"), sortir de la boucle
                if (payoutResponse.response_code === '00') {
                    console.log(`   ✅ Succès confirmé (code 00)`);
                    break;
                }
                
                // Si erreur Code 09 (interne), retenter après délai
                if (payoutResponse.response_code === '09') {
                    console.log(`   ⚠️ Code 09 reçu (erreur interne)`);
                    if (attempt < maxRetries) {
                        console.log(`   ⏳ Attente 2s avant retry...`);
                        await delay(2000);
                        continue;
                    }
                }
                
                // Autre erreur, ne pas retenter
                break;
                
            } catch (error) {
                lastError = error;
                console.log(`   ❌ Tentative ${attempt} échouée: ${error.message}`);
                if (error.response?.data) {
                    console.log(`      Data:`, error.response.data);
                }
                
                if (attempt < maxRetries) {
                    console.log(`   ⏳ Attente 2s avant retry...`);
                    await delay(2000);
                }
            }
        }
        
        // Si toutes les tentatives ont échoué
        if (!payoutResponse && lastError) {
            console.error('\n   ❌ TOUTES LES TENTATIVES ONT ÉCHOUÉ');
            
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: `Erreur réseau après ${maxRetries} tentatives: ${lastError.message}`,
                retryCount: maxRetries
            });
            
            return res.status(500).json({
                success: false,
                error: "Erreur de connexion. Réessayez dans quelques minutes.",
                details: lastError.response?.data || lastError.message,
                withdrawalId: withdrawalRef.id
            });
        }
        
        // ═══════════════════════════════════════════════
        // ÉTAPE 4 : TRAITER LA RÉPONSE DE LIGDICASH
        // ═══════════════════════════════════════════════
        console.log('\n🔍 ÉTAPE 4 : Analyse de la réponse...');
        
        const isInitiated = payoutResponse.response_code === '00';
        const ligdiCashToken = payoutResponse.token || null;
        
        if (isInitiated) {
            // ✅ PAYOUT INITIÉ AVEC SUCCÈS
            await withdrawalRef.update({
                status: 'processing',
                ligdiCashTransactionId: ligdiCashToken,
                ligdiCashResponse: payoutResponse,
                initiatedAt: new Date().toISOString()
            });
            
            console.log(`\n   ✅ ════════════════════════════════`);
            console.log(`      PAYOUT INITIÉ AVEC SUCCÈS !`);
            console.log(`   ════════════════════════════════`);
            console.log(`   ├─ ${netAmount} FCFA → ${formattedPhone}`);
            console.log(`   ├─ Token LigdiCash: ${ligdiCashToken || 'N/A'}`);
            console.log(`   └─ Statut: En attente du webhook de confirmation`);
            console.log(`   ════════════════════════════════`);
            console.log(`   ⚠️  Délai réel : quelques secondes à plusieurs jours`);
            console.log(`       selon l'opérateur (Orange, Moov, Wave, etc.)\n`);
            
            return res.json({
                success: true,
                message: `✅ Retrait de ${netAmount} FCFA initié. Vous recevrez un SMS de confirmation.`,
                withdrawalId: withdrawalRef.id,
                transactionId: ligdiCashToken,
                netAmount: netAmount,
                fee: fee,
                status: 'processing'
            });
        } else {
            // ❌ LIGDICASH A REFUSÉ LA DEMANDE
            const errorReason = payoutResponse.response_text || 
                               payoutResponse.description ||
                               payoutResponse.message || 
                               `Code erreur: ${payoutResponse.response_code}`;
            
            const wikiUrl = payoutResponse.wiki || '';
            
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: errorReason,
                ligdiCashResponse: payoutResponse,
                wikiUrl: wikiUrl,
                responseCode: payoutResponse.response_code,
                retryCount: maxRetries
            });
            
            console.log(`\n   ❌ ════════════════════════════════`);
            console.log(`      PAYOUT REFUSÉ`);
            console.log(`   ════════════════════════════════`);
            console.log(`   ├─ Code: ${payoutResponse.response_code}`);
            console.log(`   ├─ Raison: ${errorReason}`);
            if (wikiUrl) {
                console.log(`   └─ Wiki: ${wikiUrl}`);
            }
            console.log(`   ════════════════════════════════\n`);
            
            return res.status(400).json({
                success: false,
                error: errorReason,
                responseCode: payoutResponse.response_code,
                wikiUrl: wikiUrl,
                withdrawalId: withdrawalRef.id
            });
        }
        
    } catch (error) {
        // ❌ ERREUR CRITIQUE INATTENDUE
        console.error('\n❌ ERREUR CRITIQUE:');
        console.error('   Message:', error.message);
        console.error('   Stack:', error.stack);
        
        try {
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: 'Erreur serveur: ' + error.message
            });
        } catch (e) {
            console.error('   Erreur update status:', e.message);
        }
        
        res.status(500).json({
            success: false,
            error: "Erreur serveur. Réessayez.",
            details: error.message,
            withdrawalId: withdrawalRef.id
        });
    }
});

// ==========================================
// 4. WEBHOOK RETRAIT (confirmation asynchrone LigdiCash)
// ==========================================
app.post('/webhook-withdrawal', async (req, res) => {
    console.log('\n🔔 ═══════════════════════════════════════');
    console.log('   WEBHOOK RETRAIT REÇU');
    console.log('════════════════════════════════════════');
    console.log('Body:', JSON.stringify(req.body, null, 2));
    console.log('════════════════════════════════════════\n');
    
    // ✅ Répondre 200 IMMÉDIATEMENT pour éviter les retries
    res.status(200).send('OK');

    try {
        const body = req.body;
        
        // ✅ Extraire withdrawal_id depuis plusieurs sources
        let withdrawalId = extractCustom(body.custom_data, 'withdrawal_id');
        let transactionId = extractCustom(body.custom_data, 'transaction_id');
        
        // Fallback : transaction_id contient "WITHDRAW-{id}"
        if (!withdrawalId && transactionId && transactionId.startsWith('WITHDRAW-')) {
            withdrawalId = transactionId.replace('WITHDRAW-', '');
        }
        
        // Fallback : external_id
        if (!withdrawalId && body.external_id) {
            withdrawalId = body.external_id.replace('WITHDRAW-', '');
        }
        
        // Fallback : custom_data direct
        if (!withdrawalId && body.custom_data && typeof body.custom_data === 'object') {
            withdrawalId = body.custom_data.withdrawal_id;
        }
        
        if (!withdrawalId) {
            console.log('⚠️ withdrawalId introuvable dans le webhook');
            console.log('   transaction_id:', transactionId);
            console.log('   custom_data:', body.custom_data);
            console.log('   external_id:', body.external_id);
            return;
        }

        const withdrawalRef = db.collection('withdrawal_requests').doc(withdrawalId);
        const snap = await withdrawalRef.get();
        
        if (!snap.exists) {
            console.log('⚠️ Retrait introuvable:', withdrawalId);
            return;
        }

        const currentData = snap.data();
        const status = (body.status || '').toLowerCase();
        const responseCode = body.response_code;

        console.log(`📊 Webhook pour retrait ${withdrawalId}:`);
        console.log(`   ├─ Statut actuel: ${currentData.status}`);
        console.log(`   ├─ Nouveau statut: ${status}`);
        console.log(`   └─ Response code: ${responseCode}`);

        // Cas 1 : Paiement confirmé réussi
        if (status === 'completed' || status === 'success' || responseCode === '00') {
            if (currentData.status !== 'paid') {
                await withdrawalRef.update({
                    status: 'paid',
                    paidAt: new Date().toISOString(),
                    ligdiCashWebhookResponse: body
                });
                console.log(`   ✅ Confirmé PAYÉ\n`);
            } else {
                console.log(`   ℹ️ Déjà marqué comme payé\n`);
            }
        } 
        // Cas 2 : En attente
        else if (status === 'pending' || status === 'processing') {
            console.log(`   ⏳ En cours de traitement (pas de changement)\n`);
        }
        // Cas 3 : Échec
        else if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'notcompleted') {
            const failureReason = body.response_text || body.message || 'Erreur LigdiCash';
            
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: failureReason,
                ligdiCashWebhookResponse: body
            });
            console.log(`   ❌ Confirmé ÉCHOUÉ: ${failureReason}\n`);
        }
        else {
            console.log(`   ⚠️ Statut inconnu: ${status}\n`);
        }

    } catch (e) {
        console.error('❌ Erreur webhook retrait:', e.message);
        console.error('Stack:', e.stack);
    }
});

// ==========================================
// 5. ROUTE DE SANTÉ
// ==========================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'LigdiCash SmartEduAfrica API',
        version: '3.1 - Code 09 Fixed + Retry',
        endpoints: [
            'POST /initiate-payment',
            'POST /webhook',
            'POST /process-withdrawal',
            'POST /webhook-withdrawal'
        ],
        fixes: [
            'Payload simplifié (custom_data: transaction_id uniquement)',
            'Retry automatique (3 tentatives)',
            'Validation regex du numéro',
            'Montant net arrondi (entier)',
            'Description courte (<50 chars)'
        ],
        documentation: 'https://developers.ligdicash.com/api-paiement/payout/vers-mobile-money',
        timestamp: new Date().toISOString()
    });
});

// ==========================================
// DÉMARRAGE DU SERVEUR
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  🚀 Serveur LigdiCash SmartEduAfrica v3.1    ║');
    console.log('║     Actif sur le port ' + PORT + '                    ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log('📡 Endpoints disponibles :');
    console.log('   ├─ POST /initiate-payment (paiements)');
    console.log('   ├─ POST /webhook (confirmation paiements)');
    console.log('   ├─ POST /process-withdrawal (retraits marchand)');
    console.log('   └─ POST /webhook-withdrawal (confirmations retraits)');
    console.log('');
    console.log('💸 Payout : POST /pay/v01/straight/payout (OFFICIEL)');
    console.log('🔧 Corrections Code 09 :');
    console.log('   ├─ Payload simplifié (custom_data = transaction_id)');
    console.log('   ├─ Retry automatique (3 tentatives)');
    console.log('   ├─ Validation regex numéro');
    console.log('   ├─ Montant net arrondi (entier)');
    console.log('   └─ Description courte (<50 chars)');
    console.log('');
    console.log('⚠️  Délai réel : quelques secondes à plusieurs jours');
    console.log('');
});