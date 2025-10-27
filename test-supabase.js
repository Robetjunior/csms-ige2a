const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://nctwaraezhmznwindnvn.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jdHdhcmFlemhtem53aW5kbnZuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NDU3MzY1NywiZXhwIjoyMDcwMTQ5NjU3fQ.1LDRLLaWY3EwJ4iXOx1bkNMkhhOH6oZcEL22_bHp-4E';

const sb = createClient(supabaseUrl, supabaseKey);

async function testQueries() {
  console.log('=== Testando consultas Supabase ===');
  
  try {
    console.log('\n1. Testando charge_boxes_v com DRBAKANA-TEST-01:');
    const start1 = Date.now();
    const result1 = await sb.from('charge_boxes_v')
      .select('charge_box_id,site,lat,lon,address')
      .eq('charge_box_id', 'DRBAKANA-TEST-01')
      .maybeSingle();
    console.log(`Tempo: ${Date.now() - start1}ms`);
    console.log('Resultado:', JSON.stringify(result1, null, 2));
    
    console.log('\n2. Testando charge_boxes_v com DRBAKAN-TEST-01:');
    const start2 = Date.now();
    const result2 = await sb.from('charge_boxes_v')
      .select('charge_box_id,site,lat,lon,address')
      .eq('charge_box_id', 'DRBAKAN-TEST-01')
      .maybeSingle();
    console.log(`Tempo: ${Date.now() - start2}ms`);
    console.log('Resultado:', JSON.stringify(result2, null, 2));
    
    console.log('\n3. Testando consulta de nearby (lat/lon range):');
    const start3 = Date.now();
    const result3 = await sb.from('charge_boxes_v')
      .select('charge_box_id,site,lat,lon')
      .gte('lat', -24.0)
      .lte('lat', -23.0);
    console.log(`Tempo: ${Date.now() - start3}ms`);
    console.log('Resultado:', JSON.stringify(result3, null, 2));
    
  } catch (error) {
    console.error('Erro:', error);
  }
}

testQueries();