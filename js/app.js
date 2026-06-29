function showPage(id, btn){
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById(id).classList.add("active");

  document.querySelectorAll(".sidebtn").forEach(b => b.classList.remove("active"));
  if(btn) btn.classList.add("active");

  window.scrollTo(0,0);
}

function testCall(type){
  document.getElementById("testResult").innerText =
    type + "テスト電話を発信しました。※今は見た目だけです";
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

  document.getElementById("loginResult").innerText =
    "ログインしました。";

  setTimeout(closeLogin,800);
}