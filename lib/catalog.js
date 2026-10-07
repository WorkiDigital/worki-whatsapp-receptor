// Catálogo de operações autorizáveis por pessoa e cliente. Espelha `OPERATIONS` de worki-agency-agent
// (src/clients/schema.js); ao mudar um, mude o outro. `manage_access` é só do receptor (administração).
export const OPERATIONS = Object.freeze([
  'read_meta_insights', 'prepare_instagram_post', 'publish_instagram',
  'create_meta_campaign_paused', 'activate_meta_campaign',
  'send_whatsapp_group', 'create_whatsapp_group', 'send_whatsapp_poll', 'react_whatsapp_message', 'mention_whatsapp_ghost',
  'send_email', 'deploy_vercel_preview', 'deploy_vercel_production', 'edit_repo',
]);
export const ADMIN_OPERATION = 'manage_access';
export const isOperation = (o) => OPERATIONS.includes(o);
