require('dotenv').config(); 
const express = require("express");
const { io } = require("socket.io-client");
const { SocksProxyAgent } = require('socks-proxy-agent');
const { v4: uuidv4 } = require("uuid");
const { ProxyAgent } = require("proxy-agent");
const proxy =  process.env.PROXY || "";

// 创建 SocksProxyAgent  


const app = express();
const port = process.env.PORT || 7860;

var opts = {
	auth: {
		jwt: "anonymous-ask-user",
	},
	reconnection: false,
	transports: ["websocket"],
	path: "/socket.io",
	hostname: "www.perplexity.ai",
	secure: true,
	port: "443",
	extraHeaders: {
		Cookie: process.env.PPLX_COOKIE,
		"User-Agent": process.env.USER_AGENT,
		Accept: "*/*",
		priority: "u=1, i",
		Referer: "https://www.perplexity.ai/",
	},
};
if (proxy) {
	const agent = new SocksProxyAgent(proxy);  
	opts.agent = agent;
}


function toMarkdownDetails(index,title, content, url) {
	//index类型转换
	if (typeof index === "number") {
		index = index.toString();
	}
	//content可能为空
	if (content == null || content == undefined) {
		content = "";
	}
	return "\n"+`<details>
  <summary>资料[${index}]:${title}</summary>
  
  ${content}
  
  [Link](${url})
  </details>`
  }


app.post("/v1/messages", (req, res) => {
    const apiKey = req.headers['x-api-key'];

    // Retrieve the token from environment variables
    const expectedToken = process.env.TOKEN;

    // Check if the provided API key matches the expected token
    if (!apiKey || apiKey !== expectedToken) {
        return res.status(403).json({ error: 'Forbidden: Invalid API Key' });
    }
	req.rawBody = "";
	req.setEncoding("utf8");

	req.on("data", function (chunk) {
		req.rawBody += chunk;
	});

	req.on("end", async () => {
		res.setHeader("Content-Type", "text/event-stream;charset=utf-8");
		try {
			let jsonBody = JSON.parse(req.rawBody);
			if (jsonBody.stream == false) {
				res.send(
					JSON.stringify({
						id: uuidv4(),
						content: [
							{
								text: "Please turn on streaming.",
							},
							{
								id: "string",
								name: "string",
								input: {},
							},
						],
						model: "string",
						stop_reason: "end_turn",
						stop_sequence: "string",
						usage: {
							input_tokens: 0,
							output_tokens: 0,
						},
					})
				);
			} else if (jsonBody.stream == true) {
				let model=jsonBody.model;
				let open_serch=false;
				if (model.includes("search")) {
					open_serch=true;
				}
				if (jsonBody.system) {
					jsonBody.messages.unshift({ role: "system", content: jsonBody.system });
				}
                let previousMessages = jsonBody.messages
                    .map((msg) => {
						if (msg.role == "assistant" && msg.content.includes("-------------------------------------")) {
							// 分割内容,只保留分隔符之前的部分
							try{
								return "\n"+msg.role+":"+msg.content.split("-------------------------------------")[0];
							}
							catch(e){
								console.log(e);
								return msg.content
							}
						}
						if (typeof msg.content === "string") {
							return "\n"+msg.role+":"+msg.content;
						}
						if (typeof msg.content === "object") {
							//遍历，且检查是否有text属性
							if (msg.content.length > 0) {
								let text = "";
								msg.content.forEach((item) => {
									if (item.text) {
										text += item.text;
									}
								}
							);
							return "\n"+msg.role+":"+text;
							}
						}
                        return "\n"+msg.role+":"+"";
                    })
                    .join("\n\n");
				console.log(previousMessages);
                let msgid = uuidv4();
				// send message start
				res.write(
					createEvent("message_start", {
						type: "message_start",
						message: {
							id: msgid,
							type: "message",
							role: "assistant",
							content: [],
							model: model,
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 8, output_tokens: 1 },
						},
					})
				);
				res.write(createEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
				res.write(createEvent("ping", { type: "ping" }));

				// proxy response
                var socket = io("wss://www.perplexity.ai/", opts);

                socket.on("connect", function () {
					let ask_json={
						"version": "2.9",
						"source": "default",
						"attachments": [],
						"language": "en-US",
						"timezone": "America/Los_Angeles",
						"search_focus": "writing",
						"frontend_uuid": uuidv4(),
						"mode": "concise",
						"is_related_query": false,
						"is_default_related_query": false,
						"visitor_id": uuidv4(),
						"frontend_context_uuid": uuidv4(),
						"prompt_source": "user",
						"query_source": "home"
					};
					if (open_serch){
						ask_json["sources"]=["web"];
						ask_json["search_focus"]="internet";
					}
                    console.log(" > [Connected]");
                    socket
                        .emitWithAck("perplexity_ask", previousMessages, ask_json)
                        .then((response) => {
                            
                            console.log(response);

							try{
								let serch_result=JSON.parse(response["text"])["web_results"];
								if (serch_result && serch_result.length > 0){
									res.write(createEvent("content_block_delta", JSON.stringify({
										type: "content_block_delta",
										index: 0,
										delta: { type: "text_delta", text: "\n\n-------------------------------------\n\n" },
									})));
									serch_result.forEach((item, index) => {
										let chunkJSON;
										chunkJSON = JSON.stringify({
											type: "content_block_delta",
											index: 0,
											delta: { type: "text_delta", text: toMarkdownDetails(index+1,item["name"],item["snippet"],item["url"])},
										});
										res.write(createEvent("content_block_delta", chunkJSON));
									});
								}
							}catch(e){
								console.log(e);
							}
                            res.write(createEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
                            res.write(
                                createEvent("message_delta", {
                                    type: "message_delta",
                                    delta: { stop_reason: "end_turn", stop_sequence: null },
                                    usage: { output_tokens: 12 },
                                })
                            );
                            res.write(createEvent("message_stop", { type: "message_stop" }));

                            res.end();
                        }).catch((error) => {
							if(error.message != "socket has been disconnected"){
								console.log(error);
							}
						});
                });
                socket.onAny((event, ...args) => {
                    console.log(`> [got ${event}]`);
                });
                socket.on("query_progress", (data) => {
                    if(data.text){
                        var text = JSON.parse(data.text)
                        var chunk = text.chunks[text.chunks.length - 1];
                        if(chunk){
                            chunkJSON = JSON.stringify({
                                type: "content_block_delta",
                                index: 0,
                                delta: { type: "text_delta", text: chunk },
                            });
                            res.write(createEvent("content_block_delta", chunkJSON));
                        }
                    }
                });
                socket.on("disconnect", function () {
                    console.log(" > [Disconnected]");
                });
                socket.on("error", (error) => {
					chunkJSON = JSON.stringify({
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "Error occured while fetching output 输出时出现错误\nPlease refer to the log for more information 请查看日志以获取更多信息" },
					});
					res.write(createEvent("content_block_delta", chunkJSON));
					res.write(createEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
					res.write(
						createEvent("message_delta", {
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 12 },
						})
					);
					res.write(createEvent("message_stop", { type: "message_stop" }));

					res.end();
                    console.log(error);
                });
                socket.on("connect_error", function (error) {
					chunkJSON = JSON.stringify({
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "Failed to connect to the Perplexity.ai 连接到Perplexity失败\nPlease refer to the log for more information 请查看日志以获取更多信息" },
					});
					res.write(createEvent("content_block_delta", chunkJSON));
					res.write(createEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
					res.write(
						createEvent("message_delta", {
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 12 },
						})
					);
					res.write(createEvent("message_stop", { type: "message_stop" }));

					res.end();
                    console.log(error);
                });
				res.on("close", function () {
					console.log(" > [Client closed]");
					socket.disconnect();
				});
			} else {
				throw new Error("Invalid request");
			}
		} catch (e) {
			console.log(e);
			res.write(JSON.stringify({ error: e.message }));
			res.end();
			return;
		}
	});
});

// handle other
app.use((req, res, next) => {
	res.status(404).send("Not Found");
});

app.listen(port, () => {
	console.log(`Perplexity proxy listening on port ${port}`);
});

// eventStream util
function createEvent(event, data) {
	// if data is object, stringify it
	if (typeof data === "object") {
		data = JSON.stringify(data);
	}
	return `event: ${event}\ndata: ${data}\n\n`;
}
