const admin = require('firebase-admin');
const readline = require('readline');

const serviceAccount = require('./smarteduafrica-firebase-adminsdk.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ✅ MODE DRY-RUN : true = simulation (pas d'écriture), false = vraie migration
const DRY_RUN = process.argv.includes('--dry-run');

async function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans.toLowerCase());
    }));
}

async function migratePurchases() {
    console.log('');
    console.log('🔐 ═══════════════════════════════════════');
    if (DRY_RUN) {
        console.log('   🧪 MODE SIMULATION (AUCUNE ÉCRITURE)');
    } else {
        console.log('   🚀 MIGRATION RÉELLE');
    }
    console.log('═══════════════════════════════════════ 🔐');
    console.log('');
    
    try {
        console.log('📦 Recherche des achats library...');
        const purchasesSnap = await db.collection('purchases')
            .where('type', '==', 'library')
            .get();
        
        console.log(`✅ ${purchasesSnap.docs.length} achats library trouvés\n`);
        
        if (purchasesSnap.docs.length === 0) {
            console.log('ℹ️  Aucun achat à migrer');
            process.exit(0);
        }
        
        const plannedUpdates = [];
        let skipped = 0;
        let errors = 0;
        
        // PHASE 1 : Analyser SANS écrire
        for (const doc of purchasesSnap.docs) {
            const data = doc.data();
            
            if (data.sellerId) {
                skipped++;
                continue;
            }
            
            const itemId = data.itemId;
            if (!itemId) {
                errors++;
                continue;
            }
            
            try {
                const productSnap = await db.collection('digital_products').doc(itemId).get();
                
                if (!productSnap.exists) {
                    console.log(`❌ ${doc.id}: produit ${itemId} introuvable`);
                    errors++;
                    continue;
                }
                
                const productData = productSnap.data();
                const sellerId = productData.sellerId;
                
                if (!sellerId) {
                    console.log(`⚠️  ${doc.id}: le produit n'a pas de sellerId`);
                    errors++;
                    continue;
                }
                
                plannedUpdates.push({
                    purchaseId: doc.id,
                    sellerId: sellerId,
                    productTitle: productData.title || '',
                    productPrice: productData.price || data.amount,
                    itemTitle: data.itemId
                });
                
            } catch (err) {
                errors++;
            }
        }
        
        // Afficher le plan
        console.log('');
        console.log('📋 PLAN DE MIGRATION :');
        console.log('─────────────────────────────────────');
        console.log(`   ✅ À mettre à jour: ${plannedUpdates.length}`);
        console.log(`   ⏭️  Déjà migrés: ${skipped}`);
        console.log(`   ❌ Erreurs/ignorés: ${errors}`);
        console.log('─────────────────────────────────────');
        console.log('');
        
        if (plannedUpdates.length === 0) {
            console.log('ℹ️  Rien à migrer !');
            process.exit(0);
        }
        
        // Afficher les détails (max 10)
        console.log('🔍 APERÇU DES MODIFICATIONS :');
        plannedUpdates.slice(0, 10).forEach((u, i) => {
            console.log(`   ${i + 1}. Achat ${u.purchaseId}`);
            console.log(`      └─ Ajout: sellerId=${u.sellerId}`);
            console.log(`      └─ Ajout: productTitle="${u.productTitle}"`);
            console.log(`      └─ Ajout: productPrice=${u.productPrice}`);
        });
        
        if (plannedUpdates.length > 10) {
            console.log(`   ... et ${plannedUpdates.length - 10} autres`);
        }
        
        console.log('');
        
        // ✅ En mode DRY-RUN, on s'arrête là
        if (DRY_RUN) {
            console.log('🧪 SIMULATION TERMINÉE - Aucune donnée modifiée');
            console.log('   Pour exécuter vraiment: node migrate-purchases.js');
            process.exit(0);
        }
        
        // ✅ Demander confirmation AVANT d'écrire
        const answer = await askQuestion('⚠️  Confirmer la migration réelle ? (oui/non): ');
        
        if (answer !== 'oui' && answer !== 'yes') {
            console.log('❌ Migration annulée');
            process.exit(0);
        }
        
        console.log('');
        console.log('🚀 MIGRATION EN COURS...');
        console.log('');
        
        // PHASE 2 : Écrire réellement
        let updated = 0;
        for (const update of plannedUpdates) {
            try {
                await db.collection('purchases').doc(update.purchaseId).update({
                    sellerId: update.sellerId,
                    productTitle: update.productTitle,
                    productPrice: update.productPrice,
                    orderId: update.purchaseId,
                    migratedAt: new Date().toISOString()
                });
                console.log(`   ✅ ${update.purchaseId} mis à jour`);
                updated++;
            } catch (err) {
                console.error(`   ❌ Erreur sur ${update.purchaseId}: ${err.message}`);
                errors++;
            }
        }
        
        console.log('');
        console.log('═══════════════════════════════════════');
        console.log('          ✅ MIGRATION TERMINÉE');
        console.log('═══════════════════════════════════════');
        console.log(`   ✅ Mis à jour: ${updated}`);
        console.log(`   ❌ Erreurs: ${errors}`);
        console.log('═══════════════════════════════════════');
        
        process.exit(0);
        
    } catch (err) {
        console.error('\n❌ ERREUR CRITIQUE:', err);
        process.exit(1);
    }
}

migratePurchases();