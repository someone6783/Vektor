export const fakeCodex = `#!/usr/bin/python3
import sys,json,os,socket
send=lambda x:print(json.dumps(x),flush=True)
def event(method,**params):send({'method':method,'params':{'threadId':'thread','turnId':'turn',**params}})
for line in sys.stdin:
 m=json.loads(line);method=m.get('method')
 if method=='initialize':send({'id':m['id'],'result':{'userAgent':'codex/0.166.0'}})
 elif method=='model/list':send({'id':m['id'],'result':{'data':[{'id':'fixture-default','model':'fixture-codex-default','displayName':'Codex default','isDefault':True,'supportedReasoningEfforts':[{'reasoningEffort':'high'}]},{'id':'fixture-other','model':'fixture-codex-other','displayName':'Codex other','isDefault':False}],'nextCursor':None}})
 elif method=='config/read':send({'id':m['id'],'result':{'config':{'features':{k:False for k in ['shell_tool','unified_exec','apps','plugins','browser_use','computer_use']},'mcp_servers':{}}}})
 elif method=='thread/start':
  open(os.path.join(os.environ['HOME'],'state'),'w').write('private history')
  send({'id':m['id'],'result':{'thread':{'id':'thread'},'model':m.get('params',{}).get('model','fixture'),'approvalPolicy':'untrusted','cwd':'/workspace','sandbox':{'type':'readOnly'},'instructionSources':[]}})
 elif method=='thread/resume':
  if open(os.path.join(os.environ['HOME'],'state')).read()!='private history':sys.exit(2)
  send({'id':m['id'],'result':{'thread':{'id':'thread'},'model':m.get('params',{}).get('model','fixture'),'approvalPolicy':'untrusted','cwd':'/workspace','sandbox':{'type':'readOnly'},'instructionSources':[]}})
 elif method=='turn/start':
  event('turn/started',turn={'id':'turn'})
  send({'id':m['id'],'result':{'turn':{'id':'turn'}}})
  text=m['params']['input'][0]['text'].rsplit('[user]',1)[-1]
  if 'CRASH' in text:sys.exit(7)
  if 'CONTEXT_REPORT' in text:
   event('thread/tokenUsage/updated',tokenUsage={'total':{'inputTokens':10000,'outputTokens':50,'totalTokens':10050},'last':{'inputTokens':2000,'outputTokens':10,'totalTokens':2010},'modelContextWindow':272000})
   event('item/agentMessage/delta',delta='Context reported')
   event('turn/completed',turn={'id':'turn','status':'completed'})
  elif 'NATIVE_AUTH' in text:
   auth=json.load(open(os.path.join(os.environ['HOME'],'.codex/auth.json')))
   assert auth['tokens']['access_token']=='native-access-fixture'
   assert not os.environ.get('OPENAI_API_KEY')
   assert not os.path.exists('/home/aaron')
   auth['tokens']['access_token']='native-refreshed-fixture'
   json.dump(auth,open(os.path.join(os.environ['HOME'],'.codex/auth.json'),'w'))
   event('item/agentMessage/delta',delta='NATIVE ACCOUNT READY')
   event('turn/completed',turn={'id':'turn','status':'completed'})
  elif 'ISOLATION' in text:
   failures=[]
   if os.path.exists('/data') or os.path.exists('/home/aaron') or os.environ.get('VEKTOR_ACCESS_TOKEN'):failures.append('host leak')
   try:socket.create_connection(('1.1.1.1',443),timeout=.1);failures.append('direct network')
   except OSError:pass
   event('item/agentMessage/delta',delta='ISOLATED' if not failures else str(failures))
   event('turn/completed',turn={'id':'turn','status':'completed'})
  else:
   event('item/agentMessage/delta',delta='Preparing a workspace change. ')
   send({'id':'write','method':'item/tool/call','params':{'threadId':'thread','turnId':'turn','tool':'vektor_write_file','arguments':{'path':'hello.txt','content':'Human approved content'}}})
 elif m.get('id')=='write':
  event('item/agentMessage/delta',delta='Tool returned: '+str(m.get('result',{})))
  event('turn/completed',turn={'id':'turn','status':'completed'})
 elif method=='turn/interrupt':send({'id':m['id'],'result':{}})
`;

export const fakeAcp = `#!/usr/bin/python3
import sys,json,os
send=lambda m:print(json.dumps(m),flush=True)
for line in sys.stdin:
 m=json.loads(line);method=m.get('method')
 if method=='initialize':send({'id':m['id'],'result':{'protocolVersion':1,'agentInfo':{'name':'fixture-acp','version':'1.0.0'},'agentCapabilities':{'loadSession':True},'authMethods':[{'id':'api-key','name':'API key'}]}})
 elif method=='session/new':
  if os.environ.get('OPENCODE_DISABLE_AUTOUPDATE'):
   auth=json.load(open(os.path.join(os.environ['HOME'],'.local/share/opencode/auth.json')))
   if auth: assert auth['anthropic']['key']=='native-anthropic-fixture'
   else:
    config=json.load(open(os.path.join(os.environ['HOME'],'.config/opencode/opencode.json')))
    assert config['enabled_providers']==['opencode']
   assert not os.environ.get('OPENROUTER_API_KEY') and not os.environ.get('OPENAI_API_KEY')
  open(os.path.join(os.environ['HOME'],'state'),'w').write('ACP private history')
  send({'id':m['id'],'result':{'sessionId':'acp-session'}})
 elif method=='session/load':
  assert open(os.path.join(os.environ['HOME'],'state')).read()=='ACP private history'
  send({'id':m['id'],'result':{}})
 elif method=='session/prompt':
  prompt=m['params']['prompt'][0]['text'];prompt_id=m['id']
  if 'STAGED' in prompt:
   open('/workspace/staged.txt','w').write('Proposed staged content')
   send({'method':'session/update','params':{'sessionId':'acp-session','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'Prepared a staged change.'}}}})
   send({'id':prompt_id,'result':{'stopReason':'end_turn'}})
  elif 'TERMINAL' in prompt:send({'id':'create','method':'terminal/create','params':{'sessionId':'acp-session','command':'touch','args':['terminal-approved.txt'],'cwd':'/workspace'}})
  elif 'UNKNOWN_PERMISSION' in prompt:send({'id':'permission','method':'session/request_permission','params':{'sessionId':'acp-session','toolCall':{'kind':'fetch'},'options':[{'kind':'allow_always','optionId':'yes'}]}})
  elif 'OUTSIDE' in prompt:send({'id':'write','method':'fs/write_text_file','params':{'sessionId':'acp-session','path':'/etc/outside','content':'must not write'}})
  else:send({'id':'write','method':'fs/write_text_file','params':{'sessionId':'acp-session','path':'/workspace/acp-approved.txt','content':'ACP approved content'}})
 elif m.get('id')=='create' and m.get('result'):send({'id':'wait','method':'terminal/wait_for_exit','params':{'sessionId':'acp-session','terminalId':m['result']['terminalId']}})
 elif m.get('id') in ['write','permission','wait']:
  send({'method':'session/update','params':{'sessionId':'acp-session','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'ACP finished: '+str(m.get('result',m.get('error')))}}}})
  send({'id':prompt_id,'result':{'stopReason':'end_turn'}})
`;
