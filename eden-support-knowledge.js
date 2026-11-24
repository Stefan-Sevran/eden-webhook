/* Published ClinicNet product guidance shared by Ask Eden and the email draft queue. */
(function publishSupportKnowledge() {
  const articles = [
    {id:'support-access', view:'alerts', questions:[
      /\bsupport access\b|\baccess request\b|\bask(?:ed|ing)? for access\b|\brequest.*access\b/,
      /\beden.*(?:permission|access)\b|\b(?:review|find|approve).*support request\b/
    ], answer:'Select the clinic location the request was sent to. The clinic owner can open Alerts and choose the Eden support request.'},
    {id:'support-changes', view:'alerts', questions:[
      /\b(?:suggested|proposed|pending|eden.s) (?:changes|edits|tweaks)\b|\breview.*(?:proposal|changes)\b/,
      /\bapprove.*(?:change|edit|proposal)\b|\bchanges.*(?:waiting|live)\b/
    ], answer:'Select the clinic location and open Alerts. Choose the Eden support change that needs review. The clinic owner can compare what changed, then approve or dismiss the proposal.'},
    {id:'sign-in-limit', view:null, priority:2, questions:[
      /\brate limit\b|\btoo many (?:emails|requests|codes|attempts)\b|\bemail limit\b/
    ], answer:'If you have an unused sign-in link for this workspace, open it. Otherwise, wait before requesting another email.'},
    {id:'sign-in-redirect', view:null, priority:2, questions:[
      /\blocalhost\b|\bwrong (?:site|workspace|domain)\b|\bredirect.*(?:login|sign.in|link)\b/
    ], answer:'Open the intended Clinic Workspace and request a fresh sign-in email there. If your link still opens the wrong page, tell support which workspace you opened and the domain where the link landed.'},
    {id:'sign-in', view:null, questions:[
      /\bsign[ -]?in\b|\blog[ -]?in\b|\bmagic link\b|\botp\b/,
      /\b(?:verification|sign.in|login) (?:email|link|code)\b|\bcan.t get into.*workspace\b/
    ], answer:'Open the intended Clinic Workspace, enter the email address you use for that workspace, and request a fresh sign-in email. Check your inbox and spam folder. Open the newest link in the same browser profile.'},
    {id:'website-chat', view:'setup', questions:[
      /\bwebsite chat\b|\breceptionist (?:page|link|widget)\b|\b(?:chat widget|website widget)\b/,
      /\bwebsite.*(?:chat|widget|receptionist)\b/
    ], answer:'Open Connect and select Website Chat. Check the next action for the location. If the receptionist page is live, send a test inquiry from it and look for the new Website Chat entry in Daily Action.'},
    {id:'messenger', view:'setup', questions:[
      /\b(?:facebook|meta|messenger)\b/,
      /\b(?:facebook|messenger)\b.*\b(?:page|test|message|connect)\b/
    ], answer:'Open Connect and select Messenger for the clinic location. Check the linked Page and follow the next action on the connection card. If the card asks for a test, use its instructions and check Daily Action afterward.'},
    {id:'phone', view:'setup', questions:[
      /\b(?:ai phone|forwarded call|call forwarding|forwarding code|test call)\b/,
      /\b(?:carrier|twilio|elevenlabs)\b.*\b(?:phone|call|forward)\b/
    ], answer:'Open Connect and select AI Phone. Follow the forwarding instructions shown for this location and use Check test call if it’s available. Tell support your carrier and what happened on the test call if it still fails.'},
    {id:'daily-action', view:'daily', questions:[
      /\bdaily action\b|\b(?:callback|call back|inbox|inquiry|inquiries)\b/,
      /\b(?:missed|unclaimed)\b.*\b(?:call|booking|inquiry)\b/
    ], answer:'Open Daily Action for the right location. Use Needs attention to find inquiries that still need a callback or staff action. Open the inquiry to see its source and current status.'},
    {id:'bookings', view:'daily', questions:[
      /\b(?:appointment|booking|booked|reschedule)\b/,
      /\b(?:confirm|mark|see|find|check)\b.*\b(?:booking|appointment|booked)\b/
    ], answer:'Open Daily Action for the right location and select the inquiry or appointment. When the clinic has agreed on a time, use Mark booked and enter the confirmed appointment date and time.'},
    {id:'automatic-booking', view:null, priority:2, questions:[
      /\b(?:automatic booking|calendar integration|book automatically|google calendar|cliniko|acuity)\b/
    ], answer:'Which calendar or scheduling system does your clinic use? The support team can check what’s available for your location.'},
    {id:'clinic-facts', view:'profile', questions:[
      /\b(?:clinic profile|clinic facts|opening hours|business hours|public hours|booking instructions)\b/,
      /\b(?:change|update|edit|correct)\b.*\b(?:hours|address|services|clinic facts)\b/
    ], answer:'Open Clinic profile for the location. Review the patient-facing facts, such as services, hours, address, and booking instructions. An owner or authorized manager can review the information before it’s used for replies.'},
    {id:'revenue', view:'revenue', questions:[
      /\b(?:revenue rescue|settlement|counted visits|revenue report)\b/,
      /\b(?:revenue|settlement)\b.*\b(?:visit|report|payment|count)\b/
    ], answer:'Open Revenue and select the settlement you want to check. Choose View counted visits to see which visits and recorded payments are included.'},
    {id:'connection', view:'setup', questions:[
      /\b(?:connection status|setup request|channel setup|channel stuck|not connected)\b/,
      /\b(?:connect|set up|setup)\b.*\b(?:channel|receptionist|integration)\b/
    ], answer:'Open Connect for the clinic location and select the channel. The connection card shows its status and the next action. Which channel are you setting up?'},
    {id:'locations', view:null, questions:[
      /\b(?:switch|select|choose|wrong|change)\b.*\b(?:location|clinic workspace)\b|\blocation picker\b/
    ], answer:'Open the workspace selector and choose the business account and clinic location you want to manage. If the location is missing, confirm you signed in with the email address the clinic invited.'}
  ];

  const sensitive = /\b(?:patient(?:.s)? name|patient records?|medical records?|diagnos\w*|prescri\w*|refund|chargeback|invoice dispute|breach|compromised|api key|credentials?|password\s*(?:is|:)|sign.in code\s*(?:is|:))\b|\b\d{6,}\b/i;
  const privateDetails = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/\S+|\b(?:patient|invoice|payment|billing|password)\b|\+?\d[\d ().-]{7,}\d/i;

  function supportKnowledge(question) {
    const text = String(question ?? '').trim().replace(/[‘’]/g, "'").toLowerCase();
    if (!text || text.length > 4000 || sensitive.test(text)) return {decision:'human', articles:[]};
    const matches = articles.map((article, index) => ({
      article, index, score:article.questions.filter(pattern => pattern.test(text)).length
    })).filter(match => match.score).sort((a, b) =>
      b.score + (b.article.priority || 0) - a.score - (a.article.priority || 0) || a.index - b.index);
    const candidates = matches.slice(0, 4).map(match => match.article);
    if (!candidates.length) return {decision:'human', articles:[]};
    const multiTopic = /\b(?:also|another issue|second question|plus)\b|\?.*\?/s.test(text);
    if (multiTopic && candidates.length > 1) {
      return {decision:'clarify', articles:candidates, answer:'I see more than one issue in your message. Which one would you like to solve first?'};
    }
    return {decision:'answer', answer:candidates[0].answer, view:candidates[0].view, articles:candidates};
  }

  function mayUseModel(question) {
    return typeof question === 'string' && !!question.trim() && question.length <= 4000 &&
      !privateDetails.test(question) && !sensitive.test(question)
      && !/\b(?:ignore.*instructions|system prompt|developer instructions|reveal.*secret)\b/i.test(question);
  }

  const api = {supportKnowledge, mayUseModel, supportArticles:() => articles.map(({id,answer}) => ({id,answer}))};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.EdenSupportKnowledge = api;
})();
