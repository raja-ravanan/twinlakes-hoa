<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">
<html>
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta http-equiv="Content-Style-Type" content="text/css">
  <title></title>
  <meta name="Description" content="Twin Lakes at Floyds Fork is a premier lakeside community in Louisville, Kentucky. Find community updates, board information, documents, and contact details.">
  <meta name="Generator" content="Cocoa HTML Writer">
  <meta name="CocoaVersion" content="2685.3">
  <style type="text/css">
    p.p1 {margin: 0.0px 0.0px 0.0px 0.0px; font: 12.0px Times; color: #0000e9; -webkit-text-stroke: #0000e9}
    p.p2 {margin: 0.0px 0.0px 0.0px 0.0px; font: 12.0px Times; color: #0000e9; -webkit-text-stroke: #0000e9; min-height: 14.0px}
    span.s1 {font-kerning: none}
  </style>
</head>
<body>
<p class="p1"><span class="s1">const Anthropic = require("@anthropic-ai/sdk");</span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1">exports.handler = async (event) =&gt; {</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>if (event.httpMethod !== "POST") {</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>return { statusCode: 405, body: "Method Not Allowed" };</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>}</span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>const { messages } = JSON.parse(event.body);</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });</span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>const response = await client.messages.create({</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>model: "claude-sonnet-4-20250514",</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>max_tokens: 1024,</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>system: `You are a friendly HOA assistant for Twin Lakes at Floyds Fork,<span class="Apple-converted-space"> </span></span></p>
<p class="p1"><span class="s1">a residential community. Help residents with questions about rules,<span class="Apple-converted-space"> </span></span></p>
<p class="p1"><span class="s1">amenities, dues, contact info, and community updates.<span class="Apple-converted-space"> </span></span></p>
<p class="p1"><span class="s1">Keep answers concise and friendly.</span></p>
<p class="p1"><span class="s1">Key facts:</span></p>
<p class="p1"><span class="s1">- Management: Mulloy Properties, contact edouglas@mulloyproperties.com</span></p>
<p class="p1"><span class="s1">- Board email: hoa.twinlakes.board@gmail.com</span></p>
<p class="p1"><span class="s1">- [Add your CC&amp;Rs, dues amounts, pool hours, etc. here]`,</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>messages,</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>});</span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>return {</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>statusCode: 200,</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>headers: { "Content-Type": "application/json" },</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>body: JSON.stringify({ reply: response.content[0].text }),</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>};</span></p>
<p class="p1"><span class="s1">};</span></p>
</body>
</html>
