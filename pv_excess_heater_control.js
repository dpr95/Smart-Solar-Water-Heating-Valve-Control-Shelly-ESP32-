// ==========================================
// CONFIGURAÇÕES DO UTILIZADOR
// ==========================================

let EM_IP = "192.168.1.144";  // IP do Shelly EM (Medidor da Casa)

// Tabela de Potência (Os teus dados reais!)
let LUT = [
  { b: 55, p: 103 },
  { b: 60, p: 149 },
  { b: 65, p: 211 },
  { b: 70, p: 270 },
  { b: 73, p: 304 },
  { b: 75, p: 387 },
  { b: 77, p: 429 },
  { b: 78, p: 513 }, 
  { b: 79, p: 566 }, 
  { b: 80, p: 642 },
  { b: 82, p: 762 }, 
  { b: 85, p: 888 },
  { b: 86, p: 966 },
  { b: 88, p: 1127 },
  { b: 90, p: 1260 },
  { b: 95, p: 1360 }
];

// ==========================================
// LÓGICA DO CÓDIGO
// ==========================================

// Função que descobre qual é o brilho ideal para o Sol disponível
function getTargetBrightness(available_power) {
  if (available_power < 103) return 0; // Menos de 103W de sol? Desliga.
  
  let target_b = 55; // Ponto de partida
  for (let i = 0; i < LUT.length; i++) {
    if (available_power >= LUT[i].p) {
      target_b = LUT[i].b; // Vai subindo até encontrar o degrau certo
    }
  }
  return target_b;
}

function adjustHeater() {
  // 1. VERIFICAÇÃO DO HORÁRIO (Das 19h às 08h é obrigatório OFF)
  let sys = Shelly.getComponentStatus("sys");
  if (sys && sys.time) {
    let hour = sys.time.slice(0, 2) * 1; // Truque para converter texto "14" no número 14
    if (hour < 8 || hour >= 19) {
      Shelly.call("Light.GetStatus", { id: 0 }, function(status) {
        if (status.output === true) {
          // CORREÇÃO: on: false
          Shelly.call("Light.Set", { id: 0, on: false }); 
          print("Fora de horas (" + sys.time + "). A desligar para a noite.");
        }
      });
      return; // Aborta o resto do script
    }
  }

  // 2. LER A REDE (Shelly EM)
  Shelly.call("HTTP.GET", { url: "http://" + EM_IP + "/status" }, function(res, err_code) {
    if (err_code !== 0 || !res || res.code !== 200) {
      print("Erro a ler o Shelly EM! Ver se o IP esta certo.");
      return;
    }
    
    let em_data = JSON.parse(res.body);
    let grid_power = em_data.emeters[0].power; // Vai buscar o valor exato à lista
    
    // 3. LER O ESTADO DO CILINDRO (Dimmer)
    Shelly.call("Light.GetStatus", { id: 0 }, function(status) {
      let is_on = status.output;
      let current_b = status.brightness;
      let heater_power = status.apower; // Potência real do cilindro

      if (!is_on) {
        // SE ESTIVER DESLIGADO
        if (grid_power <= -150) {
          print("Sol suficiente (" + grid_power + "W). A arrancar nos 55%.");
          // CORREÇÃO: on: true
          Shelly.call("Light.Set", { id: 0, on: true, brightness: 55 });
        }
      } else {
        // SE ESTIVER LIGADO
        if (grid_power > 100 || grid_power < -100) {
          
          let available_power = heater_power - grid_power; 
          let new_b = getTargetBrightness(available_power);
          
          if (new_b === 0) {
            print("Corte Rapido! Consumo na rede: " + grid_power + "W");
            // CORREÇÃO: on: false
            Shelly.call("Light.Set", { id: 0, on: false });
          } else if (new_b !== current_b) {
            print("Ajuste: Rede=" + grid_power + "W | Cilindro=" + heater_power + "W | Alvo=" + new_b + "%");
            Shelly.call("Light.Set", { id: 0, brightness: new_b });
          } else {
             print("Estavel nos " + current_b + "% | Rede: " + grid_power + "W");
          }
        } else {
          print("Zona Morta OK (" + grid_power + "W). Nao mexe.");
        }
      }
    });
  });
}

// Executa este ciclo a cada 5 segundos (5000ms)
Timer.set(5000, true, adjustHeater);