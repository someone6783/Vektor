import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { AcpSession, CodexSession, type HarnessEvent } from "./protocol.js";
function options(source: string, events: HarnessEvent[]) {
  return {
    command: process.execPath,
    args: [
      "-e",
      `const send=m=>console.log(JSON.stringify(m));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);${source}});`,
    ],
    env: {},
    cwd: tmpdir(),
    timeoutMs: 1000,
    event: (event: HarnessEvent) => events.push(event),
  };
}
describe("Codex lifecycle", () => {
  it("streams one owned turn, normalizes items, and rejects duplicate session ownership", async () => {
    const events: HarnessEvent[] = [];
    const session = new CodexSession(
      options(
        `
      if(m.method==='initialize')send({id:m.id,result:{userAgent:'codex/0.166.0'}});
      if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread'}}});
      if(m.method==='turn/start'){
        send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});
        send({id:m.id,result:{turn:{id:'turn'}}});
        send({method:'item/agentMessage/delta',params:{threadId:'foreign',turnId:'turn',delta:'ignored'}});
        send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',delta:'Hello'}});
        for(let i=0;i<2;i++)send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'tool',type:'fileChange'}}});
        send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
      }`,
        events,
      ),
    );
    try {
      expect(await session.initialize()).toBe("codex/0.166.0");
      await session.create({});
      await expect(session.create({})).rejects.toThrow("already owns");
      await session.prompt("Hello");
      expect(events.filter((e) => e.type === "text")).toEqual([{ type: "text", text: "Hello" }]);
      expect(events.filter((e) => e.type === "tool")).toHaveLength(1);
    } finally {
      await session.close();
    }
  });
  it("fails on process death without replaying the prompt", async () => {
    const session = new CodexSession(
      options(
        `if(m.method==='initialize')send({id:m.id,result:{userAgent:'codex/0.166.0'}});if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread'}}});if(m.method==='turn/start')process.exit(1);`,
        [],
      ),
    );
    try {
      await session.initialize();
      await session.create({});
      await expect(session.prompt("Hello")).rejects.toThrow();
    } finally {
      await session.close();
    }
  });
});
describe("ACP v1 lifecycle", () => {
  it("negotiates no filesystem or terminal capabilities and denies all permission requests", async () => {
    const events: HarnessEvent[] = [];
    const session = new AcpSession(
      options(
        `
      if(m.method==='initialize'){
        if(Object.keys(m.params.clientCapabilities).length)process.exit(1);
        send({id:m.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:'fake',version:'1.0.0'},authMethods:[]}});
      }
      if(m.method==='session/new')send({id:m.id,result:{sessionId:'session'}});
      if(m.method==='session/prompt'){
        global.promptId=m.id;
        send({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello'}}}});
        send({id:'permission',method:'session/request_permission',params:{sessionId:'session',toolCall:{kind:'execute'},options:[{optionId:'yes',kind:'allow_always'}]}});
      }
      if(m.id==='permission'&&m.result){
        if(m.result.outcome.outcome!=='cancelled')process.exit(1);
        send({id:global.promptId,result:{stopReason:'end_turn'}});
      }`,
        events,
      ),
    );
    try {
      expect(await session.initialize()).toEqual({ name: "fake", version: "1.0.0" });
      await session.create("/workspace");
      await session.prompt("Hello");
      expect(events).toContainEqual({ type: "text", text: "Hello" });
    } finally {
      await session.close();
    }
  });
  it("rejects incompatible protocol versions", async () => {
    const session = new AcpSession(
      options(
        `send({id:m.id,result:{protocolVersion:2,agentCapabilities:{},agentInfo:{name:'fake',version:'1'},authMethods:[]}});`,
        [],
      ),
    );
    try {
      await expect(session.initialize()).rejects.toThrow();
    } finally {
      await session.close();
    }
  });
});
