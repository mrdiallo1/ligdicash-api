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
    
    // Enlever tous les espaces, tirets, parenthèses
    let cleaned = phone.replace(/[\s\-\(\)]/g, '');
    
    // Enlever le '+' au début
    if (cleaned.startsWith('+')) {
        cleaned = cleaned.substring(1);
    }
    
    // Si le numéro commence par '00', le remplacer par rien
    // (ex: "00226..." → "226...")
    if (cleaned.startsWith('00')) {
        cleaned = cleaned.substring(2);
    }
    
    // Si le numéro ne contient que des chiffres et commence par un 0 
    // (format local burkinabè sans indicatif), ajouter 226
    if (/^0[0-9]{7,8}$/.test(cleaned)) {
        cleaned = '226' + cleaned.substring(1);
    }
    
    return cleaned;
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
// 3. ✅ RETRAIT - PAYOUT MARCHAND (endpoint OFFICIEL LigdiCash)
// ==========================================
// Documentation : https://developers.ligdicash.com/api-paiement/payout/vers-mobile-money
// Endpoint : POST /pay/v01/straight/payout
// Délai : quelques secondes à plusieurs jours selon l'opérateur
// ==========================================
app.post('/process-withdrawal', async (req, res) => {
    const { 
        sellerId, 
        amount, 
        phone, 
        provider,
        sellerName 
    } = req.body;

    // Validation des paramètres
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

    // ✅ Formater le numéro au format LigdiCash (sans + ni espaces)
    const formattedPhone = formatPhoneNumber(phone);
    console.log(`\n💸 ═══════════════════════════════════════`);
    console.log(`   RETRAIT DEMANDÉ (Payout Marchand)`);
    console.log(`════════════════════════════════════════`);
    console.log(`   ├─ Vendeur: ${sellerId}`);
    console.log(`   ├─ Nom: ${sellerName || 'N/A'}`);
    console.log(`   ├─ Montant: ${amount} FCFA`);
    console.log(`   ├─ Provider (info): ${provider || 'auto'}`);
    console.log(`   ├─ Numéro original: ${phone}`);
    console.log(`   └─ Numéro formaté: ${formattedPhone}`);
    console.log(`════════════════════════════════════════\n`);

    // Créer la référence du document AVANT (pour avoir l'ID)
    const withdrawalRef = db.collection('withdrawal_requests').doc();
    
    try {
        // ═══════════════════════════════════════════════
        // ÉTAPE 1 : VÉRIFIER LE SOLDE DU VENDEUR
        // ═══════════════════════════════════════════════
        console.log('🔍 ÉTAPE 1 : Vérification du solde...');
        
        // 1a. Récupérer les IDs des produits du vendeur
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
        
        // 1b. Calculer les revenus totaux (80% des ventes)
        let totalRevenue = 0.0;
        
        // Méthode 1 : Ventes via sellerId
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
        
        // Méthode 2 : Fallback par itemId (anciens achats)
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
        
        // 1c. Calculer déjà retiré (status: paid)
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
        
        // 1d. Calculer en attente (pending, processing, approved)
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
        console.log(`   └─ ✅ Disponible: ${availableBalance.toFixed(2)} F`);
        console.log(`   └─ 💸 Demandé: ${amount} F\n`);
        
        // ❌ Solde insuffisant
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
        console.log('📝 ÉTAPE 2 : Création de la demande...');
        
        const fee = Math.round(amount * 0.05); // 5% de frais
        const netAmount = amount - fee;
        
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
        });
        
        console.log(`   ✅ Demande créée en statut "processing"\n`);
        
        // ═══════════════════════════════════════════════
        // ÉTAPE 3 : APPELER L'API PAYOUT OFFICIELLE LIGDICASH
        // Endpoint : POST /pay/v01/straight/payout
        // ═══════════════════════════════════════════════
        console.log('📤 ÉTAPE 3 : Envoi à LigdiCash Payout...');
        console.log('   Endpoint: POST /pay/v01/straight/payout');
        
        // ✅ Payload au format OFFICIEL LigdiCash
        const payload = {
            commande: {
                // ✅ amount : montant en XOF (entier positif)
                amount: parseInt(netAmount),
                
                // ✅ description : OBLIGATOIRE
                description: `Retrait SmartEdu - ${sellerName || 'Professeur'} - ${withdrawalRef.id}`,
                
                // ✅ customer : numéro avec indicatif, SANS '+' ni espaces
                customer: formattedPhone,
                
                // ✅ callback_url : URL HTTPS pour les notifications
                callback_url: "https://ligdicash-api.onrender.com/webhook-withdrawal",
                
                // ✅ custom_data : métadonnées avec transaction_id (recommandé)
                custom_data: {
                    transaction_id: `WITHDRAW-${withdrawalRef.id}`,
                    withdrawal_id: withdrawalRef.id,
                    seller_id: sellerId,
                    original_amount: amount,
                    fee: fee,
                    net_amount: netAmount,
                    provider: provider || 'auto'
                }
            }
        };
        
        console.log(`   ├─ Amount: ${netAmount} XOF`);
        console.log(`   ├─ Customer: ${formattedPhone}`);
        console.log(`   ├─ Description: ${payload.commande.description}`);
        console.log(`   └─ Transaction ID: WITHDRAW-${withdrawalRef.id}\n`);
        
        let payoutResponse;
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
            console.log('📥 Réponse LigdiCash reçue');
            console.log('   Response:', JSON.stringify(payoutResponse, null, 2));
        } catch (error) {
            // ❌ Erreur réseau/API → marquer comme échoué
            console.error('\n   ❌ ERREUR RÉSEAU LIGDICASH');
            console.error('   Status:', error.response?.status);
            console.error('   Data:', error.response?.data);
            console.error('   Message:', error.message);
            
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: error.response?.data?.response_text || 
                               error.response?.data?.message || 
                               error.message || 
                               'Erreur connexion LigdiCash'
            });
            
            return res.status(500).json({
                success: false,
                error: "Erreur lors de l'envoi Mobile Money. Réessayez dans quelques instants.",
                details: error.response?.data || error.message,
                withdrawalId: withdrawalRef.id
            });
        }
        
        // ═══════════════════════════════════════════════
        // ÉTAPE 4 : TRAITER LA RÉPONSE DE LIGDICASH
        // ═══════════════════════════════════════════════
        console.log('\n🔍 ÉTAPE 4 : Analyse de la réponse...');
        
        // ✅ Un response_code === "00" signifie que le payout a été INITIÉ
        // Le résultat final arrive via webhook
        const isInitiated = payoutResponse.response_code === '00';
        const ligdiCashToken = payoutResponse.token || null;
        
        if (isInitiated) {
            // ✅ PAYOUT INITIÉ AVEC SUCCÈS
            // Le statut passe à "processing" en attendant le webhook
            // Le webhook changera le statut en "paid" ou "failed"
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
            
            // Retourner un statut "processing" à l'app
            return res.json({
                success: true,
                message: `✅ Retrait de ${netAmount} FCFA initié. Vous recevrez un SMS de confirmation.`,
                withdrawalId: withdrawalRef.id,
                transactionId: ligdiCashToken,
                netAmount: netAmount,
                fee: fee,
                status: 'processing'  // ⚠️ PAS "paid" - on attend le webhook !
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
                wikiUrl: wikiUrl
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
        
        // Nettoyer : marquer la demande comme échouée
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
// Ce webhook est appelé par LigdiCash quand le payout est finalisé
// (payé ou échoué). Délai : quelques secondes à plusieurs jours.
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
        
        // ✅ Extraire transaction_id depuis custom_data (format recommandé)
        // Le transaction_id est notre identifiant unique : "WITHDRAW-{id}"
        let transactionId = extractCustom(body.custom_data, 'transaction_id');
        let withdrawalId = extractCustom(body.custom_data, 'withdrawal_id');
        
        // Fallback : chercher dans external_id
        if (!withdrawalId && body.external_id) {
            withdrawalId = body.external_id.replace('WITHDRAW-', '');
        }
        
        // Fallback : chercher dans custom_data directement
        if (!withdrawalId && body.custom_data) {
            if (typeof body.custom_data === 'object') {
                withdrawalId = body.custom_data.withdrawal_id;
            }
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
        // Cas 2 : En attente (pas de changement)
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
        // Cas 4 : Statut inconnu
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
        version: '3.0 - Official Payout Endpoint',
        endpoints: [
            'POST /initiate-payment',
            'POST /webhook',
            'POST /process-withdrawal',
            'POST /webhook-withdrawal'
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
    console.log('║  🚀 Serveur LigdiCash SmartEduAfrica v3.0    ║');
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
    console.log('⚠️  Délai réel : quelques secondes à plusieurs jours');
    console.log('');
});