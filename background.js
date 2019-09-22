activeTab = false;
sounds = []; // List of tab ids that have had audio

chrome.tabs.onActivated.addListener(activeInfo => {
  activeTab = activeInfo.tabId; // Current tab
  chrome.tabs.sendMessage(activeTab, false); // Resume when active
});

chrome.tabs.onRemoved.addListener(tabId => {
  delete sounds.splice(sounds.indexOf(tabId),1);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo)  => {
  if(!changeInfo.hasOwnProperty("audible")) return // Bool that contains if audio is playing on tab
  if(changeInfo.audible) {
    if(!sounds.includes(changeInfo)) sounds.push(tabId); // Tab has sound
  }
  if(tabId === activeTab) Broardcast(changeInfo.audible, activeTab); // Tell the other tabs the state of the active tab
});

async function Broardcast(message, exclude = false) {
  sounds.forEach(id => { // Only for tabs that have had sound
      if(id === exclude) return
      chrome.tabs.sendMessage(id, message);
  });
};
