const GAS_URL = "https://script.google.com/macros/s/AKfycby3IYoihcK2Tqw6V5kP5RapzLEIyZPcBNITi-Rl0RZnJzJbqwAx14jZshowuspu-SBC/exec";

function showPage(id, btn){
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById(id).classList.add("active");

  document.querySelectorAll(".sidebtn").forEach(b => b.classList.remove("active"));
  if(btn) btn.classList.add("active");

  window.scrollTo(0,0);
}

async function testCall(type){
  document.getElementById("testResult").innerText = "送信中...";

  try{
    const res = await fetch(GAS_URL, {
      method: "POST",
      body: JSON.stringify({
        action: "testCall",
        type: type,
        time: new Date().toLocaleString("ja-JP")
      })
    });

    const data = await res.text();
    document.getElementById("testResult").innerText = data;

  }catch(e){
    document.getElementById("testResult").innerText = "通信エラー：" + e.message;
  }
}

function openLogin(){
  document.getElementById("loginModal").style.display = "flex";
}

function closeLogin(){
  document.getElementById("loginModal").style.display = "none";
}

function login(){
  const email = document.getElementById("loginEmail").value;
  const password = document.getElementById("loginPassword").value;

  if(email === "" || password === ""){
    document.getElementById("loginResult").innerText =
      "メールアドレスとパスワードを入力してください。";
    return;
  }

  localStorage.setItem("callnow_login","true");
  localStorage.setItem("callnow_email",email);

  document.getElementById("loginResult").innerText = "ログインしました。";
  setTimeout(closeLogin,800);
}