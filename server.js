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
// 3. TRAITER UN RETRAIT (Payout via LigdiCash)
// ==========================================
app.post('/process-withdrawal', async (req, res) => {
    const { withdrawalId, adminId } = req.body;

    if (!withdrawalId || !adminId) {
        return res.status(400).json({ error: "Données manquantes (withdrawalId/adminId requis)" });
    }

    try {
        // 1. Récupérer la demande de retrait
        const withdrawalRef = db.collection('withdrawal_requests').doc(withdrawalId);
        const withdrawalSnap = await withdrawalRef.get();
        
        if (!withdrawalSnap.exists) {
            return res.status(404).json({ error: "Demande introuvable" });
        }

        const withdrawal = withdrawalSnap.data();
        
        // Vérifier que la demande est approuvée
        if (withdrawal.status !== 'approved') {
            return res.status(400).json({ error: "Demande non approuvée (statut: " + withdrawal.status + ")" });
        }

        console.log(`\n💸 ═══ TRAITEMENT RETRAIT ${withdrawalId} ═══`);
        console.log(`   ├─ Montant brut: ${withdrawal.amount} FCFA`);
        console.log(`   ├─ Frais: ${withdrawal.fee} FCFA`);
        console.log(`   ├─ Montant net: ${withdrawal.netAmount} FCFA`);
        console.log(`   ├─ Provider: ${withdrawal.mobileMoneyProvider}`);
        console.log(`   ├─ Numéro: ${withdrawal.sellerPhone}`);
        console.log(`   └─ Bénéficiaire: ${withdrawal.sellerName}`);

        // 2. Marquer comme "en cours" AVANT d'appeler LigdiCash
        await withdrawalRef.update({
            status: 'processing',
            processingAt: new Date().toISOString(),
            processedBy: adminId
        });

        // 3. Préparer le payload pour LigdiCash Payout
        const sellerNameParts = (withdrawal.sellerName || 'Professeur SmartEdu').split(' ');
        const firstName = sellerNameParts[0];
        const lastName = sellerNameParts.slice(1).join(' ') || 'SmartEdu';

        const payload = {
            payout: {
                // Montant à envoyer (net après frais)
                amount: parseInt(withdrawal.netAmount),
                currency: "XOF",
                
                // Informations du bénéficiaire
                phone_number: withdrawal.sellerPhone.replace(/\s+/g, ''),
                first_name: firstName,
                last_name: lastName,
                
                // Opérateur Mobile Money
                provider: withdrawal.mobileMoneyProvider.toLowerCase(),
                
                // Description
                description: `Retrait SmartEdu - ${withdrawal.sellerName}`,
                
                // Référence unique
                external_id: `WITHDRAW-${withdrawalId}`,
                
                // Callback URL
                callback_url: "https://ligdicash-api.onrender.com/webhook-withdrawal"
            },
            custom_data: {
                withdrawal_id: withdrawalId,
                seller_id: withdrawal.sellerId,
                admin_id: adminId,
                original_amount: withdrawal.amount,
                fee: withdrawal.fee,
                net_amount: withdrawal.netAmount
            }
        };

        console.log('📤 Envoi requête Payout à LigdiCash...');
        console.log('   Payload:', JSON.stringify(payload, null, 2));

        // 4. Appeler l'API Payout de LigdiCash
        const response = await axios.post(
            'https://app.ligdicash.com/pay/v01/payout/initiate',
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

        const data = response.data;
        console.log('📥 Réponse LigdiCash:', JSON.stringify(data, null, 2));

        // 5. Vérifier le succès
        const isSuccess = data.response_code === '00' || 
                         data.status === 'success' || 
                         data.status === 'pending' ||
                         data.transaction_id ||
                         data.token;

        if (isSuccess) {
            await withdrawalRef.update({
                ligdiCashTransactionId: data.transaction_id || data.token || null,
                ligdiCashResponse: data
            });

            console.log(`✅ Retrait ${withdrawalId} envoyé à LigdiCash`);
            console.log(`   └─ Transaction ID: ${data.transaction_id || data.token || 'N/A'}\n`);

            res.json({
                success: true,
                message: "Paiement initié via LigdiCash",
                transaction_id: data.transaction_id || data.token,
                data: data
            });
        } else {
            // Échec
            const errorReason = data.response_text || data.message || 'Erreur LigdiCash inconnue';
            
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: errorReason,
                ligdiCashResponse: data
            });

            console.log(`❌ Échec du retrait: ${errorReason}\n`);

            res.status(500).json({
                success: false,
                error: errorReason,
                data: data
            });
        }

    } catch (error) {
        console.error('❌ Erreur traitement retrait:', error.response ? error.response.data : error.message);
        console.error('Stack:', error.stack);
        
        // Marquer comme échoué
        try {
            await db.collection('withdrawal_requests').doc(withdrawalId).update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: error.response?.data?.message || error.message
            });
        } catch (e) {
            console.error('Erreur update status failed:', e.message);
        }

        res.status(500).json({
            success: false,
            error: "Erreur lors du traitement du retrait",
            details: error.response ? error.response.data : error.message
        });
    }
});

// ==========================================
// 4. WEBHOOK RETRAIT (confirmation LigdiCash)
// ==========================================
app.post('/webhook-withdrawal', async (req, res) => {
    console.log('\n🔔 ═══ WEBHOOK RETRAIT REÇU ═══');
    console.log('Body:', JSON.stringify(req.body, null, 2));
    res.status(200).send('OK');

    try {
        const body = req.body;
        
        // Extraire withdrawal_id depuis custom_data
        const withdrawalId = extractCustom(body.custom_data, 'withdrawal_id') || 
                            body.external_id?.replace('WITHDRAW-', '') ||
                            body.payout?.external_id?.replace('WITHDRAW-', '');
        
        if (!withdrawalId) {
            console.log('⚠️ withdrawalId introuvable dans le webhook');
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

        const status = (body.status || '').toLowerCase();
        const responseCode = body.response_code;

        console.log(`📊 Webhook pour retrait ${withdrawalId}:`);
        console.log(`   ├─ status: ${status}`);
        console.log(`   ├─ response_code: ${responseCode}`);

        // Cas 1 : Paiement réussi
        if (status === 'completed' || status === 'success' || responseCode === '00') {
            await withdrawalRef.update({
                status: 'paid',
                paidAt: new Date().toISOString(),
                ligdiCashWebhookResponse: body
            });
            console.log(`✅ Retrait ${withdrawalId} PAYÉ avec succès\n`);
        } 
        // Cas 2 : En attente
        else if (status === 'pending' || status === 'processing') {
            console.log(`⏳ Retrait ${withdrawalId} en cours de traitement\n`);
        }
        // Cas 3 : Échec
        else if (status === 'failed' || status === 'error' || status === 'cancelled') {
            const failureReason = body.response_text || body.message || 'Erreur LigdiCash';
            
            await withdrawalRef.update({
                status: 'failed',
                failedAt: new Date().toISOString(),
                failureReason: failureReason,
                ligdiCashWebhookResponse: body
            });
            console.log(`❌ Retrait ${withdrawalId} ÉCHOUÉ: ${failureReason}\n`);
        }
        // Cas 4 : Statut inconnu
        else {
            console.log(`⚠️ Statut inconnu pour retrait ${withdrawalId}: ${status}\n`);
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
        endpoints: [
            'POST /initiate-payment',
            'POST /webhook',
            'POST /process-withdrawal',
            'POST /webhook-withdrawal'
        ],
        timestamp: new Date().toISOString()
    });
});

// ==========================================
// DÉMARRAGE DU SERVEUR
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║  🚀 Serveur LigdiCash SmartEduAfrica     ║');
    console.log('║     Actif sur le port ' + PORT + '              ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    console.log('📡 Endpoints disponibles :');
    console.log('   ├─ POST /initiate-payment');
    console.log('   ├─ POST /webhook (paiements)');
    console.log('   ├─ POST /process-withdrawal (retraits profs)');
    console.log('   └─ POST /webhook-withdrawal (confirmations)');
    console.log('');
});