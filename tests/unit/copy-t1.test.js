import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const { copyViolations, assertRenderedCopy, bannedCopyViolations } = require("./copy-helpers");
const LL = require("../../level-logic");
const ROOT = path.resolve(import.meta.dirname, "../..");

// Exercise the shipped renderer functions with a small DOM, without a browser or mic.
function renderer() {
  const elements=new Map();
  const element=id=>{
    if (!elements.has(id)) elements.set(id, {id,textContent:"",hidden:false,style:{display:"",setProperty(){}},attributes:{},className:"",classList:{toggle(){},add(){},remove(){}},
      setAttribute(k,v){this.attributes[k]=v;},toggleAttribute(k,on){if(on)this.attributes[k]="";else delete this.attributes[k];},querySelector(){return element(id+":use");},addEventListener(){},focus(){}});
    return elements.get(id);
  };
  const context={console, setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},performance:{now:()=>0},
    window:{LevelLogic:LL},document:{getElementById:element,addEventListener(){}},localStorage:{getItem(){return null;},setItem(){}},module:undefined};
  let source=fs.readFileSync(path.join(ROOT,"renderer.js"),"utf8");
  source=source.slice(0,source.lastIndexOf("}"))+`
    compactPill=$("compactPill"); expandedPanel=$("expandedPanel"); sessionCompletePanel=$("sessionCompletePanel");
    globalThis.probe={render,renderCalibration,pillWord,micText,reanchorText,setCalib,
      drive(values){
        if (values.manager) calibrationManager=values.manager;
        if (values.status) captureStatus=values.status;
        if (values.calibration) calibration=values.calibration;
        if (values.tracker) tracker=values.tracker;
        if (values.session) sessionTracker={};
        if (values.phase) calib=values.phase;
      }};
  }`;
  vm.runInNewContext(source,context,{filename:"renderer.js"});
  return {probe:context.probe,element,elements};
}

describe("T1 copy contract",()=>{
  it("ships every owned static CR row and removes replaced copy",()=>{
    expect(copyViolations("T1")).toEqual([]);
  });
  it("renders representative dynamic pill, meter and voice-setup copy",()=>{
    const {probe,element,elements}=renderer();
    probe.render({zone:"normal",label:"Normal",relDb:7,level:68});
    assertRenderedCopy("CR-002",element("compactPill").attributes["aria-label"],{state:"Normal"});
    assertRenderedCopy("CR-025",LL.formatRelative(7),{n:7});
    assertRenderedCopy("CR-026",element("dbReadout").textContent,{n:7});
    probe.drive({phase:"talk",status:{device:{label:"Shure MV7"}},manager:{getProgress:()=>.4,getProgressDetails:()=>({hint:"noise"})}});
    probe.render({zone:"calibrating",label:"Learning voice",relDb:null,level:0});
    assertRenderedCopy("CR-028",element("pillWord").textContent,{pct:40});
    assertRenderedCopy("CR-042",element("calText").textContent,{heard:4,mic:"Shure MV7"});
    expect(element("calHint").textContent).toContain("Hearing steady noise, not talking.");
    probe.drive({manager:{getProgress:()=>.8,getProgressDetails:()=>({extended:true})}});
    probe.render({zone:"calibrating",label:"Learning voice",relDb:null,level:0});
    expect(element("calHint").textContent).toBe("Almost there. Keep talking.");
    probe.drive({phase:"saved"});
    probe.renderCalibration({zone:"normal"},"Normal",{mark:"g-ok",cls:"normal"});
    assertRenderedCopy("CR-055",element("calText").textContent,{mic:"Shure MV7"});
    probe.drive({tracker:{snapshot:()=>({reanchored:true,reanchorDb:-3})},session:true});
    assertRenderedCopy("CR-039",probe.reanchorText(),{"signed n":"−3"});
    expect(bannedCopyViolations([...elements.values()].map(e=>e.textContent).filter(Boolean))).toEqual([]);
  });
  it("renders threshold labels and ready update versions",()=>{
    const {createUpdaterState}=require("../../updater-state");
    const s=createUpdaterState();s.onDownloaded("2.5.1");
    assertRenderedCopy("CR-228",s.label,{version:"2.5.1"});
    assertRenderedCopy("CR-008","+"+LL.marginsFor(0).warningDb,{threshold:6});
    expect(bannedCopyViolations([s.label])).toEqual([]);
  });
});

function shellHarness() {
  const {EventEmitter}=require("node:events");
  const messages=[], sent=[], windows=[];
  const app=Object.assign(new EventEmitter(),{
    isPackaged:true,whenReady:()=>({then(){}}),getVersion:()=>"2.5.0",
    setAboutPanelOptions(options){this.aboutOptions=options;},showAboutPanel(){this.aboutShown=true;},quit(){}
  });
  const updater=Object.assign(new EventEmitter(),{quitAndInstall(){},checkForUpdates:async()=>null});
  class Store { constructor(o){this.data={...o.defaults};} get(k){return this.data[k];} set(k,v){this.data[k]=v;} }
  class Tray extends EventEmitter {setToolTip(){}setContextMenu(menu){this.menu=menu;}setImage(){} }
  const electron={app,Tray,BrowserWindow:{getAllWindows:()=>windows},Menu:{buildFromTemplate:items=>({items})},
    dialog:{showMessageBox:async(...args)=>{messages.push(args.at(-1));return {response:1};}},
    nativeImage:{createFromPath:()=>({setTemplateImage(){}})},ipcMain:new EventEmitter(),systemPreferences:{},globalShortcut:{},screen:{},shell:{}};
  const fakeRequire=id=>{
    if(id==="electron")return electron;
    if(id==="electron-store")return Store;
    if(id==="electron-updater")return {autoUpdater:updater};
    if(id==="./session-ipc")return {registerSessionIpc(){}};
    if(id==="./permission-manager")return class {getStatus(){return "granted";}};
    if(id==="./tray-icon-renderer")return {createTrayIcon:()=>({}),resetVolumeHistory(){}};
    if(id==="./capture/mode")return {};
    if(id.startsWith("./"))return require(path.join(ROOT,id));
    return require(id);
  };
  const context={require:fakeRequire,__dirname:ROOT,process:{env:{},platform:"darwin"},console,setTimeout:()=>1,setInterval:()=>1};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT,"main.js"),"utf8")+`
    mainWindow={isDestroyed:()=>false,webContents:{send:(...args)=>globalThis.sent.push(args)}};
    globalThis.probe={createTray,buildMenuTemplate,showAboutDialog,setupAutoUpdater,maybePromptUpdate,checkForUpdates,
      getTray:()=>tray,setActive(value,phase="idle"){isMonitoring=value;captureMode={summary:()=>({phase}),menuItems:()=>[]};}};
  `,Object.assign(context,{sent}));
  return {probe:context.probe,updater,messages,sent,app};
}

it("menu-bar click opens the installed menu and sends no toggle-monitoring (B1/B19)",()=>{
  const {probe,sent}=shellHarness();
  probe.createTray();
  const tray=probe.getTray();
  expect(tray.menu.items.map(i=>i.label).filter(Boolean)).toEqual(
    ["Start Monitoring","Voice Setup…","History","Settings…","Check for Updates…","About quietpls","Quit quietpls"]);
  tray.emit("click");
  expect(sent).toEqual([]);
  const pill=probe.buildMenuTemplate({isMonitoring:false});
  expect(pill.map(i=>i.label)).toEqual(tray.menu.items.map(i=>i.label));
  pill[0].click();
  expect(sent).toEqual([["toggle-monitoring",true]]);
  expect(bannedCopyViolations(pill.map(i=>i.label).filter(Boolean))).toEqual([]);
});

it("uses the native About panel and defers a downloaded update through monitoring and recording (B13/B14)",()=>{
  const {probe,updater,messages,app}=shellHarness();
  probe.showAboutDialog();
  expect(app.aboutShown).toBe(true);
  assertRenderedCopy("CR-209",`Version ${app.aboutOptions.applicationVersion}`,{version:"2.5.0"});
  probe.setupAutoUpdater();
  probe.setActive(true);
  updater.emit("update-downloaded",{version:"2.5.1"});
  expect(messages).toHaveLength(0);
  probe.setActive(false,"recording");probe.maybePromptUpdate();
  expect(messages).toHaveLength(0);
  probe.setActive(false);probe.maybePromptUpdate();
  expect(messages).toHaveLength(1);
  assertRenderedCopy("CR-217",messages[0].message,{version:"2.5.1"});
  probe.maybePromptUpdate();expect(messages).toHaveLength(1);
  expect(bannedCopyViolations(messages.flatMap(m=>[m.title,m.message,m.detail]))).toEqual([]);
});

it("answers a manual update failure with the diagnostic and a retry action", async () => {
  const { probe, updater, messages } = shellHarness();
  const detail = "The connection is offline.";
  updater.checkForUpdates = () => Promise.reject(new Error(detail));
  probe.checkForUpdates(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(messages).toHaveLength(2);
  expect(messages[0].title).toBe("Couldn’t Check for Updates");
  expect(messages[0].detail).toBeUndefined();
  expect(messages[0].buttons).toContain("Show Details");
  assertRenderedCopy("CR-215", messages[1].detail, { "diagnostic detail": detail });
});
