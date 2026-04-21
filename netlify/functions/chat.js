const Anthropic = require("@anthropic-ai/sdk");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { messages } = JSON.parse(event.body);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: `You are a friendly HOA assistant for Twin Lakes at Floyds Fork, 
a residential community in Louisville, Kentucky. 
Help residents with questions about rules, amenities, dues, 
contact info, and community updates. Keep answers concise and friendly.
Key facts:
- Management: Mulloy Properties, contact edouglas@mulloyproperties.com
- Board email: hoa.twinlakes.board@gmail.com`,
      messages,
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: response.content[0].text }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
