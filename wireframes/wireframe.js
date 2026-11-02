// Navigation prototype only. Business rules remain in the canonical master.
const state = {page:'login', role:'Operator', status:'Draft', cooldown:7, valid:false,
  filter:'RETRY', loan:null, scenario:'normal', note:'', comment:'', portfolio:null, job:0, revision:1};
const app = document.getElementById('app');
const button = (label, action, primary=false, disabled=false) =>
  `<button data-action="${action}" ${primary?'class="primary"':''} ${disabled?'disabled':''}>${label}</button>`;
const notice = text => `<div class="notice" role="status">${text}</div>`;
const names = {RETRY:'Retry candidates',WAIT:'Waiting',REVIEW_REMEDIATE:'Needs attention'};
const examples = [
  {id:'example-retry', label:'DEMO-001', amount:'1,000.00', decision:'RETRY', why:'Insufficient funds. Waiting period completed.', next:'Check the candidate before submitting the results.'},
  {id:'example-wait', label:'DEMO-002', amount:'750.00', decision:'WAIT', why:'The waiting period is not complete.', next:'Reassess on or after the next check date.'},
  {id:'example-review', label:'DEMO-003', amount:'1,520.00', decision:'REVIEW_REMEDIATE', why:'Two simultaneous requests have the same amount.', next:'Check both requests before considering another attempt.'}
];
const counts = () => {const t={3:[404,1945],7:[400,1949],14:[396,1953]}[state.cooldown];return {RETRY:t[0],WAIT:t[1],REVIEW_REMEDIATE:713}};
const format = n => n.toLocaleString('en-US');
const escapeHTML = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fixtureDates = row => {
  if(row.decision==='REVIEW_REMEDIATE')return {anchor:'2025-11-10',next:'Not applicable'};
  const days=row.decision==='RETRY'?state.cooldown:state.cooldown-1;
  const date=new Date('2025-11-11T12:00:00Z');date.setUTCDate(date.getUTCDate()-days);
  const anchor=date.toISOString().slice(0,10);date.setUTCDate(date.getUTCDate()+state.cooldown);
  return {anchor,next:date.toISOString().slice(0,10)};
};
const stage = () => ({Ready:'Ready for review',Submitted:'Awaiting reviewer',Returned:'Changes requested',Approved:'Approved',Draft:'Draft',Validated:'Ready to process',Running:'Processing',Interrupted:'Processing interrupted'}[state.status]||state.status);
function render(){
  document.getElementById('identity').innerHTML = state.page==='login'?'Signed out':`${state.role} ${button('Sign out','logout')}`;
  if(state.page==='login'){
    app.innerHTML=`<main class="login"><h1>Sign in</h1><p>Prepare and review your collection results.</p>${state.scenario==='expired'?notice('Your session expired. Sign in again to continue.'):''}<p>Preview account: <strong>${state.role}</strong></p>${button('Sign in to preview','login',true)}<p class="muted">Simulated access. Do not enter real credentials.</p></main>`;
    return;
  }
  const labels={workspace:'Workspace',prepare:'Portfolio',results:'Results',output:'Approved output'};
  const complete=['Ready','Submitted','Returned','Approved'].includes(state.status);
  app.innerHTML=`<div class="layout"><nav aria-label="Main navigation">${Object.keys(labels).map(p=>`<button data-page="${p}" ${state.page===p?'aria-current="page"':''} ${p==='output'&&state.status!=='Approved'?'disabled':''}>${labels[p]}</button>`).join('')}</nav><main><p class="muted">${state.portfolio?'Portfolio selected':'Select portfolio'} → ${complete?'Results ready':'Generate results'} → ${state.status==='Approved'?'Approved':state.status==='Submitted'?'In review':'Review'} → Output</p>${state.note?notice(state.note):''}${state.page==='workspace'?workspace():state.page==='prepare'?prepare():state.page==='output'?output():results()}</main></div>`;
  const cooldown=document.getElementById('cooldown');
  if(cooldown)cooldown.onchange=()=>{state.cooldown=Number(cooldown.value)};
  const file=document.getElementById('loans');if(file)file.onchange=()=>{if(file.files.length){state.portfolio=file.files[0].name;state.valid=false;render()}};
}
function workspace(){return `<div class="toolbar"><div><h1>Collection analyses</h1><p class="muted">Find your results or prepare a new portfolio.</p></div>${button('New analysis','new',true,state.role!=='Operator')}</div><div class="table-wrap"><table><thead><tr><th>Portfolio</th><th>Status</th><th>Loans</th><th></th></tr></thead><tbody><tr><td>Sample lending portfolio</td><td>${stage()}</td><td>${state.valid||['Ready','Submitted','Returned','Approved'].includes(state.status)?'3,062':'Not processed'}</td><td>${button('Open','open')}</td></tr></tbody></table></div>`}
function prepare(){
  const draft=state.status==='Draft'&&state.role==='Operator';
  return `<h1>Prepare your portfolio</h1><p>Choose a loan portfolio. Payment history is already available.</p><section><label>Loan portfolio CSV<input type="file" id="loans" accept=".csv" ${draft?'':'disabled'}></label>${state.portfolio?`<p><strong>Selected:</strong> ${escapeHTML(state.portfolio)}</p>`:'<p>Or use the sample to walk through without a file.</p>'}${button('Use sample portfolio','sample',false,!draft)}<p class="muted">Prototype: only a filename is retained. File contents are not read or uploaded.</p><p><strong>Payment history:</strong> ${state.scenario==='history'?'Unavailable. Contact the setup owner.':'Available in the system.'}</p><details><summary>History details</summary><p>Original challenge extract · 253,006 expected requests. Historical data, not a live bank feed. Actual import provenance will be provided by the backend.</p></details><details><summary>Analysis settings</summary><label>Waiting period<select id="cooldown" ${draft?'':'disabled'}>${[3,7,14].map(n=>`<option ${state.cooldown===n?'selected':''}>${n}</option>`).join('')}</select> calendar days</label><p>Reference date: November 11, 2025 · Mexico City.</p></details></section>${state.valid?notice('Portfolio checked · 3,062 reference loans · 3,033 with history · 29 without history. Ready to generate the preview.'):''}<div class="actions">${state.status==='Draft'?button('Check portfolio','validate',true,!draft):''}${state.status==='Validated'?button('Generate results','run',true,state.role!=='Operator'):''}${['Ready','Submitted','Returned','Approved'].includes(state.status)?button('View results','viewresults',true):''}${['Returned','Interrupted','Approved','Ready'].includes(state.status)?button('Start revised analysis','revision',false,state.role!=='Operator'):''}</div>`;
}
function results(){
  if(!['Ready','Submitted','Returned','Approved','Superseded'].includes(state.status))return `<h1>Results</h1>${notice(state.status==='Running'?'Processing your portfolio… Results will appear when processing is complete.':state.status==='Interrupted'?'Processing was interrupted. No complete results were saved. Start a revised analysis to try again.':'No results yet. Check your portfolio and generate results to continue.')}<div class="actions">${button('Back to portfolio','prepare',true)}${state.status==='Interrupted'?button('Start revised analysis','revision',false,state.role!=='Operator'):''}</div>`;
  const total=counts();const rows=examples.filter(x=>x.decision===state.filter);
  return `<div class="toolbar"><div><h1>Results</h1><p>3,062 loans processed <span aria-hidden="true">·</span> <strong>${stage()}</strong></p></div></div><p class="muted">Reference totals · the three demonstration loans, balances and dates are synthetic. No real analysis has run.</p><div class="queue-tabs" role="group" aria-label="Result queues">${Object.keys(names).map(d=>`<button data-action="queue:${d}" aria-pressed="${state.filter===d}">${names[d]} <strong>${format(total[d])}</strong></button>`).join('')}</div><p>${{RETRY:'Check these candidates before submitting the complete results for review.',WAIT:'These loans are waiting for their next reassessment.',REVIEW_REMEDIATE:'These loans need clarification before another attempt.'}[state.filter]}</p><p class="muted">Showing ${rows.length} illustrative example of ${format(total[state.filter])} reference loans. Example rows are synthetic and excluded from totals.</p><div class="table-wrap"><table><thead><tr><th>Loan</th><th>Outstanding</th><th>Why it is here</th><th>Next check</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td>${x.label}</td><td>MXN ${x.amount}</td><td>${x.why}</td><td>${fixtureDates(x).next}</td><td>${button('View details','loan:'+x.id)}</td></tr>`).join('')}</tbody></table></div>${state.loan?loanDetails():''}${state.status==='Returned'?notice('Changes requested: '+escapeHTML(state.comment)+'. Prepare a new revision to respond.'):''}${state.status==='Approved'?`<section class="evidence"><h2>Approved results</h2><p>Your full portfolio output is ready for handoff.</p><p>3,062 loans · Approved by Reviewer (simulated)</p><p class="muted">The CSV contains all loans, not only the open tab. This prototype previews the download; it does not generate a file.</p></section>`:''}${reviewActions()}<p class="muted">These are collection recommendations. Approval does not send or schedule a debit.</p><details><summary>Analysis details</summary><p>Waiting period: ${state.cooldown} days · Reference date: November 11, 2025 · Mexico City.</p><p>Original portfolio + system payment history. Source hashes, immutable revision and review time will be supplied by the real backend.</p></details>`;
}
function loanDetails(){
  const x=examples.find(r=>r.id===state.loan);
  if(!x)return notice('This example is unavailable. Close it and choose another loan.');
  const dates=fixtureDates(x);
  return `<section class="evidence"><div class="toolbar"><h2>${x.label}</h2>${button('Close details','close')}</div><p><strong>${names[x.decision]}</strong> · MXN ${x.amount} outstanding</p><p>${x.why}</p><h3>What to do next</h3><p>${x.next}</p><dl><dt>Latest payment date</dt><dd>${dates.anchor}</dd><dt>Next check</dt><dd>${dates.next}</dd></dl><details><summary>Payment history and decision evidence</summary><p>Synthetic demonstration records, not original loan data.</p><div class="table-wrap"><table><thead><tr><th>Request</th><th>Created / completed</th><th>Amount MXN</th><th>Outcome</th></tr></thead><tbody>${(x.decision==='REVIEW_REMEDIATE'?[1,2]:[1]).map(i=>`<tr><td>${x.label}-REQ-${i}</td><td>${dates.anchor} 12:00 / 12:05 Mexico City</td><td>100.00</td><td>Failed · insufficient funds</td></tr>`).join('')}</tbody></table></div><p>${x.decision==='REVIEW_REMEDIATE'?'Repeated amounts in the simultaneous batch require clarification before cooldown is considered.':`Waiting period: ${state.cooldown} calendar days. Elapsed: ${x.decision==='RETRY'?state.cooldown:state.cooldown-1}. ${x.decision==='RETRY'?'Boundary met.':'Not due yet.'}`}</p></details></section>`;
}
function reviewActions(){
  if(state.role==='Operator'&&state.status==='Ready')return `<div class="actions">${button('Submit for review','submit',true)}${button('Revise analysis','revision')}</div><p class="muted">Submission includes all 3,062 loans across all three queues.</p>`;
  if(state.role==='Operator'&&state.status==='Submitted')return `<div class="actions">${button('Withdraw submission','withdraw')}</div><p>Waiting for a Reviewer. Results cannot be changed while submitted.</p>`;
  if(state.role==='Reviewer'&&state.status==='Submitted')return `<div class="actions">${button('Approve results','approve',true)}</div><details><summary>Request changes instead</summary><label>What needs to change?<textarea id="comment" placeholder="Explain what the operator should address"></textarea></label>${button('Return to operator','return')}</details>`;
  if(state.status==='Approved')return `<div class="actions">${button('View approved output','output',true)}${state.role==='Operator'?button('Start revised analysis','revision'):''}</div>`;
  if(state.role==='Operator'&&state.status==='Returned')return `<div class="actions">${button('Start revised analysis','revision',true)}</div>`;
  return '<p class="muted">Only the preparing Operator can submit; only a distinct Reviewer can approve a submitted result.</p>';
}
function output(){
  if(state.status!=='Approved')return `<h1>Output not approved</h1><p>Submit the results for review before downloading an output.</p>${button('Back to results','viewresults',true)}`;
  const total=counts();
  return `<h1>Approved output</h1><p><strong>Approved by Reviewer</strong> · Demonstration revision ${state.revision}</p><section><h2>Full portfolio handoff</h2><p>3,062 reference loans · ${format(total.RETRY)} retry candidates · ${format(total.WAIT)} waiting · 713 needing attention.</p><p>The implemented app will export this complete approved portfolio. This prototype has not calculated or produced that file.</p></section><section><h2>Download the walkthrough sample</h2><p>Contains only DEMO-001, DEMO-002 and DEMO-003 with synthetic amounts and dates. It is not the original portfolio result or the post-GTM demo deliverable.</p>${button('Download 3-row sample CSV','download-sample',true)}<p class="muted">Filename: Wireframe_Synthetic_Output.csv. Every row is marked as a wireframe fixture and cannot execute a payment.</p></section><div class="actions">${button('Back to results','viewresults')}${button('Back to workspace','workspace')}</div><p>Approval and download never send or schedule a debit.</p>`;
}
function downloadSample(){
  const actions={RETRY:'PREPARE_RETRY_HANDOFF',WAIT:'REASSESS_ON_OR_AFTER_DATE',REVIEW_REMEDIATE:'INVESTIGATE_BEFORE_RETRY'};
  const quote=x=>'"'+String(x).replaceAll('"','""')+'"';
  const rows=[['dataset_kind','loan_id','outstanding_mxn','decision','next_action_code','next_check_date','recommended_amount','is_executable','review_state','prototype_revision']];
  for(const x of examples)rows.push(['wireframe_fixture',x.label,x.amount.replaceAll(',',''),x.decision,actions[x.decision],x.decision==='REVIEW_REMEDIATE'?'':fixtureDates(x).next,'','false','SIMULATED_APPROVED',state.revision]);
  const blob=new Blob([rows.map(r=>r.map(quote).join(',')).join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Wireframe_Synthetic_Output.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  state.note='Sample downloaded: 3 synthetic rows only. No real portfolio output or payment was created.';
}
document.addEventListener('click',e=>{
  const nav=e.target.closest('[data-page]');if(nav){if(nav.disabled)return;state.page=nav.dataset.page;state.note='';render();return}
  const b=e.target.closest('[data-action]');if(!b||b.disabled)return;
  const action=b.dataset.action;state.note='';
  if(action==='login'){state.page='workspace'}
  else if(action==='logout'){state.page='login'}
  else if(action==='open'){state.page=['Draft','Validated','Interrupted'].includes(state.status)?'prepare':'results'}
  else if(action==='new'||action==='revision'){state.job++;state.revision++;state.status='Draft';state.valid=false;state.loan=null;state.portfolio=action==='new'?null:state.portfolio;state.page='prepare'}
  else if(action==='sample'){state.portfolio='Sample portfolio (prototype)';state.valid=false}
  else if(action==='prepare')state.page='prepare';
  else if(action==='viewresults')state.page='results';
  else if(action==='workspace')state.page='workspace';
  else if(action==='output'){if(state.status==='Approved')state.page='output'}
  else if(action==='download-sample'){if(state.status==='Approved')downloadSample()}
  else if(action==='preview'){state.job++;state.status='Ready';state.page='results';state.filter='RETRY';state.loan=null;state.portfolio='Sample portfolio (prototype)';document.querySelector('.scenario').open=false}
  else if(action.startsWith('queue:')){state.filter=action.slice(6);state.loan=null}
  else if(action.startsWith('loan:'))state.loan=action.slice(5);
  else if(action==='close')state.loan=null;
  else if(action==='validate'){
    if(state.scenario==='history'){state.valid=false;state.note='Payment history is unavailable. Contact the setup owner, then start a revised analysis.'}
    else if(!state.portfolio)state.note='Choose your loan portfolio CSV or use the sample portfolio to continue.';
    else if(state.scenario==='invalid')state.note='The portfolio is missing the loan_id column. Correct the file and try again.';
    else{state.valid=true;state.status='Validated'}
  }
  else if(action==='run'){
    if(state.status!=='Validated'||state.role!=='Operator')return;
    state.status='Running';state.page='results';
    const job=++state.job,interrupt=state.scenario==='interrupted';
    setTimeout(()=>{if(job!==state.job)return;state.status=interrupt?'Interrupted':'Ready';render()},900);
  }
  else if(action==='submit')state.status='Submitted';
  else if(action==='withdraw')state.status='Ready';
  else if(action==='approve'){if(state.role==='Reviewer'&&state.status==='Submitted'){state.status='Approved';state.page='output';state.loan=null}}
  else if(action==='return'){
    const text=document.getElementById('comment').value.trim();
    if(!text)state.note='Add a comment explaining what needs to change.';
    else{state.comment=text;state.status='Returned'}
  }
  else if(action==='export')state.note='Download preview only. The app will export all 3,062 approved results. No file was created and no debit was sent.';
  render();
});
document.getElementById('scenario').onchange=e=>{state.scenario=e.target.value;if(state.scenario==='expired')state.page='login';render()};
document.getElementById('demo-role').onchange=e=>{state.role=e.target.value;state.page='login';state.note='';document.querySelector('.scenario').open=false;render()};
document.getElementById('reset').onclick=()=>location.reload();
render();
