activeTab = false;
sounds = [];

chrome.tabs.onActivated.addListener(activeInfo => {
  activeTab = activeInfo.tabId;
  chrome.tabs.sendMessage(activeTab, false);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo)  => {
  if(!changeInfo.hasOwnProperty("audible")) return
  if(changeInfo.audible) {
    if(!sounds.includes(changeInfo)) sounds.push(tabId);
  }
  if(tabId === activeTab) Broardcast(changeInfo.audible, activeTab);
});

async function Broardcast(message, exclude = false) {
  sounds.forEach(id => {
      if(id === exclude) return
      chrome.tabs.sendMessage(id, message);
  });
};
