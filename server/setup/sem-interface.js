// `./dashboard instalar --sem-interface` (D10): os mesmos passos sem perguntas, por
// opções, para quem automatiza. A identidade do servidor precisa ser informada
// (--identidade SHA256:…) — nada de aceitar a primeira que aparecer — e a senha, quando
// houver, vem pelo stdin (--senha-stdin), nunca pela linha de comando.
import { THRESHOLD_LIMITS } from './instalacao.js';

export const HEADLESS_HELP = `Uso: ./dashboard instalar --sem-interface --servidor <ip> --usuario <nome> --identidade <SHA256:…> [opções]

  --porta <n>             porta SSH (padrão 22)
  --identidade <SHA256:…> impressão digital do servidor (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub)
  --senha-stdin           lê a senha do usuário da 1ª linha do stdin (sem ela: usa sua chave SSH)
  --pastas "<a b>"        pastas a acompanhar (padrão: as recomendadas)
  --smart "<sda sdb>"     discos com teste SMART, ou "nenhum" (padrão: os recomendados)
  --rede <interface>      interface de rede, ou "nenhuma" (padrão: a da rota padrão)
  --servicos "<a b>"      serviços, ou "nenhum" (padrão: os recomendados)
  --disco <%> --memoria <%> --temperatura <°C>   limiares (padrão 90 / 90 / 60)
  --modo manual           só mostra os blocos para colar no servidor e sai (código 3)
  --ja-preparado          o servidor já foi preparado à mão: só testa e conclui
  --sem-origem            não limita a chave a este computador (sem from=)
  --sem-inicio-automatico não liga o serviço ao iniciar o computador
  --sem-atalho            não cria o atalho no menu
`;

const list = (v, none) => (v === undefined ? undefined : String(v).trim() === none ? [] : String(v).split(/[\s,]+/).filter(Boolean));

async function readLine(stream) {
  let data = '';
  for await (const chunk of stream) {
    data += chunk;
    if (data.includes('\n')) break;
  }
  return data.split('\n')[0].replace(/\r$/, '');
}

export async function runHeadless({ out, inst, flags, stdin = process.stdin }) {
  const fail = (msg, how) => { out.fail(msg); if (how) out.explain('', how); return 2; };
  if (flags.ajuda || flags.help) { out.line(HEADLESS_HELP); return 0; }
  if (!flags.servidor || !flags.usuario) return fail('faltam --servidor e --usuario', 'veja: ./dashboard instalar --sem-interface --ajuda');
  if (!flags.identidade || flags.identidade === true) {
    return fail('falta --identidade', 'confira no servidor com: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub e passe o SHA256:… aqui');
  }
  try {
    const s = await inst.definirServidor({ host: flags.servidor, user: flags.usuario, port: flags.porta || 22 });
    out.ok(`servidor ${s.host} responde`, `${s.ms} ms · porta ${s.port}`);
    const id = await inst.lerIdentidade();
    if (id.fingerprint !== flags.identidade) {
      return fail(`a identidade do servidor é ${id.fingerprint}, não a informada`, 'pare e confira: pode ser outro aparelho no mesmo endereço.');
    }
    out.ok('identidade do servidor confere', id.fingerprint);
    const senha = flags['senha-stdin'] ? await readLine(stdin) : '';
    const det = await inst.conectar({ senha, confirmo: true });
    out.ok(`conectado como ${det.usuario}`, det.sudoTexto);
    const rec = det.escolhas;
    const lim = {};
    for (const [key, flag] of [['diskPct', 'disco'], ['ramPct', 'memoria'], ['tempC', 'temperatura']]) {
      lim[key] = flags[flag] !== undefined ? Number(flags[flag]) : THRESHOLD_LIMITS[key][2];
    }
    const ch = inst.definirEscolhas({
      mounts: list(flags.pastas, '') ?? rec.mounts,
      smart: list(flags.smart, 'nenhum') ?? rec.smart,
      netIf: flags.rede === undefined ? rec.netIf : flags.rede === 'nenhuma' ? '' : String(flags.rede),
      services: list(flags.servicos, 'nenhum') ?? rec.services,
      limiares: lim,
    });
    out.ok('o que monitorar', `pastas ${ch.escolhas.mounts.join(' ')} · SMART ${ch.escolhas.smart.join(' ') || '—'} · rede ${ch.escolhas.netIf || '—'} · serviços ${ch.escolhas.services.join(' ') || '—'}`);
    const plan = inst.planoPreparo({ from: !flags['sem-origem'] });

    if (flags.modo === 'manual') {
      out.line();
      out.line('Cole estes blocos no terminal DO SERVIDOR, um por vez:');
      for (const b of plan.blocos.filter((x) => x.id !== 'pronto')) {
        out.line();
        out.line(out.c.bold(`# ${b.titulo} (${b.detalhe})`));
        out.line(b.codigo);
      }
      out.line();
      out.line('Depois rode o mesmo comando com --ja-preparado.');
      return 3;
    }
    if (flags['ja-preparado']) {
      for (const b of plan.blocos) {
        const r = await inst.testarBloco(b.id);
        if (!r.ok) return fail(`${b.titulo}: ${r.erro}`);
        out.ok(b.titulo, 'conferido');
      }
    } else {
      const r = await inst.prepararAssistido({});
      if (!r.ok) return fail(r.erro, 'confira o usuário e a senha, ou use --modo manual.');
      out.ok('servidor preparado', `usuário dashmon · chave restrita${plan.temSmart ? ' · sudo só para smartctl -H' : ''}`);
    }
    const t = inst.resumoTeste();
    out.ok('primeira coleta', `${t.duracaoMs ?? '?'} ms · ${t.bytes ?? '?'} bytes`);
    inst.concluir({ iniciarComComputador: !flags['sem-inicio-automatico'], atalho: !flags['sem-atalho'] });
    const lig = await inst.ligarPainel({ iniciarComComputador: !flags['sem-inicio-automatico'] });
    if (!lig.ok) return fail(`o painel não subiu: ${lig.erro}`, 'rode ./dashboard diagnosticar.');
    out.ok(lig.servico && lig.servico.ok ? 'painel rodando como serviço de usuário' : 'painel rodando em segundo plano');
    out.line(`  link de entrada (uso único, 2 min): ${lig.url}`);
    return 0;
  } catch (err) {
    inst.esquecerSenha();
    if (err.status) return fail(err.message);
    throw err;
  }
}
