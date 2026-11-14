const test=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const {createRequire}=require('node:module');const pkg=require('../../package.json');const req=createRequire(path.resolve(__dirname,'../../package.json'));const {AppInfo}=req('app-builder-lib/out/appInfo');const semver=req('semver');
test('fork metadata produces a stable Windows build and preserves upstream comparisons',()=>{
 assert.equal(pkg.version,'0.83.0+m4xp1.4');assert.equal(pkg.build.buildVersion,'0.83.0.4');assert.equal(pkg.build.buildNumber,'4');
 const info=new AppInfo({metadata:pkg,config:pkg.build,devMetadata:pkg},undefined);
 assert.equal(info.version,pkg.version);assert.equal(info.getVersionInWeirdWindowsForm(),pkg.build.buildVersion);assert.equal(info.channel,null);
 assert.equal(semver.eq(pkg.version,'0.83.0'),true);assert.equal(semver.gt('0.83.1',pkg.version),true);assert.equal(semver.gt('0.83.0',pkg.version),false);
});

assert.equal(pkg.dependencies['@openai/codex-sdk'],'0.167.0');
