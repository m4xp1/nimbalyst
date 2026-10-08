const test=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const {createRequire}=require('node:module');const pkg=require('../../package.json');const req=createRequire(path.resolve(__dirname,'../../package.json'));const {AppInfo}=req('app-builder-lib/out/appInfo');const semver=req('semver');
test('fork metadata produces a stable Windows build and preserves upstream comparisons',()=>{
 assert.equal(pkg.version,'0.79.1+m4xp1.3');assert.equal(pkg.build.buildVersion,'0.79.1.3');assert.equal(pkg.build.buildNumber,'3');
 const info=new AppInfo({metadata:pkg,config:pkg.build,devMetadata:pkg},undefined);
 assert.equal(info.version,pkg.version);assert.equal(info.getVersionInWeirdWindowsForm(),'0.79.1.3');assert.equal(info.channel,null);
 assert.equal(semver.eq(pkg.version,'0.79.1'),true);assert.equal(semver.gt('0.79.2',pkg.version),true);assert.equal(semver.gt('0.79.1',pkg.version),false);
});
