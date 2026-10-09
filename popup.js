const button = document.getElementById('openSidePanel');
const notice = document.getElementById('popupNotice');

button.addEventListener('click', async () => {
  button.disabled = true;
  notice.textContent = '작업 화면을 여는 중…';
  try {
    const windowInfo = await chrome.windows.getCurrent();
    if (typeof chrome.sidePanel?.open !== 'function') throw new Error('이 브라우저에서는 작업 화면을 열 수 없어요.');
    await chrome.sidePanel.open({ windowId: windowInfo.id });
    window.close();
  } catch (error) {
    notice.textContent = error.message || String(error);
    button.disabled = false;
  }
});
