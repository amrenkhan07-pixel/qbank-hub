// The publishable key is safe to expose. Override these values at deploy time by
// setting window.QBANK_CONFIG before app.js loads; never put a service-role key here.
export const config = window.QBANK_CONFIG || {
  supabaseUrl: 'https://flulljensjugfcxmeczu.supabase.co',
  supabasePublishableKey: 'sb_publishable_d5IIiEJ_rsjRBkdASV7RZQ_CZQzo9-1',
};
