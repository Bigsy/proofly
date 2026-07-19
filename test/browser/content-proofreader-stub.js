(() => {
  document.documentElement.setAttribute("data-proofly-test-stub", "loaded");
  const replacements = [
    { from: "seen", to: "saw", type: "grammar" },
    { from: "eated", to: "ate", type: "grammar" },
    { from: "loafs", to: "loaves", type: "spelling" },
    { from: "teh", to: "the", type: "spelling" },
  ];

  function syntheticCorrections(text) {
    if (text.includes("In France we ate.")) {
      return [{
        startIndex: text.indexOf("France") + "France".length,
        endIndex: text.indexOf("France") + "France".length,
        correction: ",",
        types: ["punctuation"],
      }];
    }
    if (text.includes("very very good")) {
      const start = text.indexOf("very very good");
      return [{
        startIndex: start,
        endIndex: start + "very ".length,
        correction: "",
        types: ["grammar"],
      }];
    }
    return [];
  }

  const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = async (message, ...args) => {
    if (message?.type !== "harper:lint") return originalSendMessage(message, ...args);
    const text = message.text;
    const corrections = syntheticCorrections(text);
    for (const { from, to, type } of replacements) {
      const start = text.indexOf(from);
      if (start < 0) continue;
      corrections.push({
        startIndex: start,
        endIndex: start + from.length,
        correction: to,
        suggestions: [{ replacement: to }],
        types: [type],
      });
    }
    return { type: "harper:result", requestId: message.requestId, corrections };
  };
})();
