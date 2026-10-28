"use strict";
const input = document.querySelector("#confirmation");
const start = document.querySelector("#start");
input.oninput = () => {
  start.disabled = input.value !== "ALWAYS ON";
};
start.onclick = () => {
  if (!start.disabled) window.qpc.ambientConfirm(input.value);
};
document.querySelector("#cancel").onclick = () => window.qpc.ambientCancel();
