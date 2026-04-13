const loginForm = document.getElementById("login-form");
const passwordInput = document.getElementById("password");
const loginStatusNode = document.getElementById("login-status");

function setLoginStatus(message, isError = false) {
  loginStatusNode.textContent = message;
  loginStatusNode.dataset.error = isError ? "true" : "false";
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = passwordInput.value.trim();

  if (!password) {
    setLoginStatus("Введите пароль.", true);
    return;
  }

  setLoginStatus("Проверка пароля...");

  try {
    const response = await fetch("/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ password })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Не удалось войти");
    }

    window.location.href = "/dashboard";
  } catch (error) {
    setLoginStatus(error.message, true);
  }
});
