const assert=require('node:assert/strict');
const {test}=require('node:test');
const i18next=require('i18next');
const {receivedContent}=require('../src/api/integrations/chatbot/chatwoot/utils/received-content.ts');

test('template document preserves media, filename, caption, footer and reply context',()=>{
 const context={stanzaId:'original-wa-id'};
 const original={templateMessage:{contextInfo:context,hydratedFourRowTemplate:{hydratedTitleText:'Título',hydratedContentText:'Texto',hydratedFooterText:'Rodapé',documentMessage:{fileName:'arquivo.pdf',mimetype:'application/pdf',caption:'Legenda',mediaKey:Uint8Array.from([1,2])},hydratedButtons:[{callButton:{displayText:'Telefone',phoneNumber:'+12025550102'}}]}}};
 const result=receivedContent(original);
 assert.equal(result.documentMessage.fileName,'arquivo.pdf');assert.deepEqual([...result.documentMessage.mediaKey],[1,2]);assert.equal(result.documentMessage.contextInfo,context);
 for(const text of ['Título','Texto','Legenda','Rodapé','Telefone','+12025550102'])assert.ok(result.documentMessage.caption.includes(text));
 assert.equal(original.templateMessage.hydratedFourRowTemplate.documentMessage.caption,'Legenda');
});

test('unsupported templates and incomplete poll options remain unchanged',()=>{
 for(const message of [{templateMessage:{templateId:'metadata-only'}},{pollCreationMessageV3:{name:'Pergunta',options:[{}]}},{secretEncryptedMessage:{secretEncType:2}}])assert.equal(receivedContent(message),message);
});

test('display headers support English and Brazilian Portuguese',async()=>{
 for(const [lng,buttons,poll] of [['en','Buttons','Poll'],['pt-BR','Botões','Enquete']]){
  await i18next.changeLanguage(lng);
  assert.ok(receivedContent({templateMessage:{hydratedTemplate:{hydratedButtons:[{quickReplyButton:{displayText:'Sim',id:'never-send'}}]}}}).extendedTextMessage.text.includes(buttons));
  assert.ok(receivedContent({pollCreationMessageV3:{name:'Pergunta',options:[{optionName:'Sim'}]}}).extendedTextMessage.text.includes(poll));
 }
});
