#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),bridge=require('./bridge.cjs');
const [command,dataFile,stateFile,inputFile,outputFile]=process.argv.slice(2);
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const write=(f,x)=>{if(!f)throw Error('Output path required');const temp=f+'.tmp';fs.writeFileSync(temp,JSON.stringify(x));fs.renameSync(temp,f)};
try{
 if(command==='init'){const data=bridge.dataset(read(dataFile)),reference=read(stateFile);write(inputFile,data);write(outputFile,bridge.open(data,{registry:reference.registry,concept_families:reference.concept_families||[],mappings:{}}).state);}
 else {const data=read(dataFile),a=bridge.open(data,read(stateFile));
  if(command==='normalize')write(inputFile,a.state);
  else if(command==='export-families')write(inputFile,bridge.familyPacket(a));
  else if(command==='export-unresolved')write(inputFile,{version:1,registry_revision:a.registryRevision(),registry:a.state.registry,questions:data.questions.filter(q=>!a.state.mappings[q.id]).map(q=>a.packet(q,true))});
  else if(command==='import-classified'){const packet=bridge.importClassified(a,data,read(inputFile));write(outputFile,packet);write(stateFile,a.state);}
  else if(command==='export-verifier'){const ids=read(inputFile);write(outputFile,bridge.verificationPacket(a,data,ids));}
  else if(command==='import-verifier'){const report=a.importVerification(read(inputFile));write(stateFile,a.state);write(outputFile,report.counts);}
  else if(command==='import-families'){bridge.importFamilies(a,read(inputFile));write(stateFile,a.state);}
  else if(command==='render'){const template=fs.readFileSync(inputFile,'utf8').replace(/const IMPORTED_DRAFT_STATE=.*;\n/,()=>`const IMPORTED_DRAFT_STATE=${JSON.stringify(a.state).replace(/</g,'\\u003c')};\n`);fs.writeFileSync(outputFile,template.replace('/*DATA*/',()=>JSON.stringify(data).replace(/</g,'\\u003c')).replace('/*PIPELINE*/',()=>fs.readFileSync(path.join(__dirname,'pipeline.js'),'utf8')));}
  else if(command==='publish'){write(outputFile,bridge.publish(a,data,read(inputFile)));}
  else throw Error('Commands: init, normalize, export-families, export-unresolved, import-classified, export-verifier, import-verifier, import-families, publish');
 }
}catch(e){console.error(e.message);process.exitCode=1;}
