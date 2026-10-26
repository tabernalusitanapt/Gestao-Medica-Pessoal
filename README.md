# Gestão Médica Pessoal

Protótipo de uma aplicação web instalável para Android. Não é ainda uma aplicação Android nativa nem está publicada numa loja.

## Funcionalidades

- PIN de seis dígitos para cifrar os dados guardados no dispositivo.
- PIN individual opcional por perfil para mudar para uma vista limitada durante uma sessão aberta pelo responsável.
- Perfis individuais com contacto, morada, localidade, código postal, cidade e identificação de saúde opcionais.
- Registo, pesquisa e edição de consultas, exames, análises, receitas, medicamentos e despesas.
- Fotografia/imagem ou PDF anexado a qualquer registo; as imagens são reduzidas para poupar espaço e cada PDF pode ter até 20 MB.
- Estado do registo, data, hora, notas e despesa em euros.
- Lista de despesas e resumo mensal.
- Leitura OCR em português no próprio dispositivo, com revisão manual antes de guardar. Em PDFs, é extraído texto digital ou reconhecida a primeira página quando esta é uma digitalização.
- Relatórios de despesas por fármaco, consultas, exames realizados e análises realizadas, por mês, trimestre, semestre ou ano, com escolha explícita do mês e ano.
- Datas apresentadas e introduzidas em DD/MM/AAAA.
- Notificações locais para registos nas próximas 24 horas, enquanto a app está aberta.
- Criação direta de eventos no Google Calendar após a configuração e autorização da conta.
- Exportação e importação de cópias de segurança cifradas, para guardar manualmente no Google Drive.
- Interface responsiva, instalável e disponível offline depois do primeiro carregamento.
- Fonte Lusitana incluída localmente; licença em `assets/fonts/OFL.txt`.
- PDF.js 4.10.38 incluído para leitura local de PDFs; licença Apache-2.0 em `assets/pdf/LICENSE`.
- Bloqueio automático após dois minutos com a app em segundo plano.

## Utilização

Sirva esta pasta através de HTTPS para instalar a app num telemóvel Android. Para experimentar no computador, sirva-a em `localhost` e abra o endereço no navegador. O acesso a funcionalidades protegidas do navegador, como armazenamento e notificações, requer um contexto seguro (`HTTPS` ou `localhost`).

No Android, abra o endereço HTTPS em Chrome e escolha **Instalar aplicação** ou **Adicionar ao ecrã inicial**. Na primeira abertura, crie um PIN de seis dígitos. Em qualquer tipo de registo, pode escolher uma imagem ou PDF ou tirar uma fotografia: **Fotografar documento** pede autorização à câmara e abre a câmara traseira no Android ou a webcam no computador. Se o acesso direto não estiver disponível ou for recusado, pode usar a câmara do dispositivo como alternativa. Depois da captura, escolha **Ler documento e preencher dados** e confirme as sugestões antes de guardar. O acesso direto à câmara requer HTTPS ou `localhost` e autorização do navegador. O motor OCR e o modelo português, bem como o leitor PDF, são carregados localmente; os documentos não são enviados para serviços externos. Para PDFs digitalizados, o OCR analisa apenas a primeira página; texto selecionável pode ser extraído dessa página. Cada documento PDF pode ter até 20 MB.

As datas são mostradas no formato `DD/MM/AAAA`. No formulário, também podem ser digitadas diretamente nesse formato.

## Publicação no GitHub Pages

O site é estático e pode ser publicado diretamente nesta pasta, sem processo de compilação. O workflow em `.github/workflows/pages.yml` publica automaticamente o conteúdo quando há um push para `main` ou quando é iniciado manualmente.

1. Crie um repositório GitHub público e envie os ficheiros desta pasta para a branch `main`.
2. Em **Settings → Pages**, escolha **GitHub Actions** como origem de publicação.
3. Aguarde a execução do workflow. O GitHub Pages apresentará o endereço HTTPS do site; abra-o no Chrome do Android e escolha **Instalar aplicação** ou **Adicionar ao ecrã inicial**.

O repositório contém apenas os ficheiros da aplicação. Os registos e anexos são guardados localmente no dispositivo; nunca os adicione ao repositório nem publique cópias de segurança.

## Relatórios e calendário

Em **Relatórios**, escolha mensal, trimestral, semestral ou anual e selecione o mês e o ano. Os medicamentos são agrupados pelo nome do fármaco (o nome do registo do tipo **Medicamento**) e pelas respetivas despesas. As consultas incluem os registos do tipo **Consulta** e apresentam a data e o custo. Exames e análises apresentam contagem, nome/tipo e custo; só são incluídos quando o estado é **Concluído**. Para que uma compra apareça nos gastos da farmácia, registe-a como **Medicamento**, com o nome e custo. As despesas gerais podem ser registadas com o tipo **Despesa**.

Para criar eventos diretamente no Google Calendar:

1. Crie um projeto na Google Cloud Console e ative a **Google Calendar API**.
2. Configure o ecrã de consentimento OAuth e crie um ID de cliente OAuth do tipo **Aplicação Web**.
3. Em **Origem JavaScript autorizada**, adicione o endereço HTTPS exato onde publicou esta app.
4. Em **Definições → Google Calendar**, cole e guarde o ID público terminado em `.apps.googleusercontent.com`.
5. Ao criar um evento a partir de um registo, autorize a app na janela da Google. O evento é então criado diretamente no calendário principal, sem um formulário Google para confirmar.

A autorização utiliza o sistema oficial do Google Identity Services; não introduza a palavra-passe nesta app. A criação de eventos exige internet e autorização para `calendar.events`.

## Cópia de segurança e privacidade

O armazenamento local usa AES-GCM-256, com uma chave derivada do PIN mestre por PBKDF2-SHA-256 (310 000 iterações) e sal aleatório. Cada gravação usa um vetor de inicialização novo. Imagens e outros dados também ficam dentro do conteúdo cifrado. O PIN mestre não fica guardado. Os PINs individuais são representados por verificadores derivados por PBKDF2 dentro do cofre cifrado.

Em **Definições**, exporte o ficheiro `.json` cifrado e carregue-o manualmente para o Google Drive. A app não pede as credenciais Google e não tem sincronização automática. Para recuperar a cópia, descarregue-a, importe-a e introduza o mesmo PIN. A importação substitui os dados locais atuais.

**Não existe recuperação do PIN mestre.** Esquecer o PIN pode tornar os dados e as cópias irrecuperáveis. Um PIN tem apenas um milhão de combinações; a derivação de chave abranda tentativas, mas não transforma o PIN num segredo forte. Proteja o telemóvel e mantenha as cópias num local privado.

## Acesso individual aos perfis

Em **Perfis**, o responsável pode definir um PIN de seis dígitos para cada pessoa. Para passar o telemóvel a um familiar, o responsável abre primeiro o cofre com o PIN mestre e escolhe **Definições → Passar acesso a um perfil**. O familiar seleciona o seu perfil e introduz o respetivo PIN. A vista individual limita a lista, os relatórios, as despesas e a edição aos registos associados ao perfil. A pessoa também pode corrigir os seus dados de contacto. Só o responsável pode gerir os PINs, configurar o Calendar, importar/exportar cópias ou eliminar registos.

Este PIN identifica o perfil na interface, mas **não substitui nem desbloqueia o cofre**: o PIN mestre continua a ser necessário para abrir a app após um bloqueio, fecho ou recarregamento. Enquanto a sessão mestre estiver aberta, a restrição é visual e não cria uma barreira criptográfica entre os perfis. Não protege contra alguém que inspecione ou manipule a app no dispositivo. Não recolhemos nem guardamos impressões digitais; a biometria do Android não informa a app sobre qual dedo foi reconhecido.

## Limitações deste protótipo

- Os avisos são emitidos apenas quando a app está aberta e o navegador autoriza notificações; não são alarmes de fundo garantidos.
- O ID de cliente OAuth do Calendar tem de ser criado/configurado pelo utilizador na Google Cloud Console. A criação do evento exige internet.
- A app não liga diretamente ao Google Drive. Sincronização automática exige uma integração Google Drive separada.
- O PIN individual do perfil apenas restringe a interface numa sessão já aberta pelo PIN mestre; não é uma separação criptográfica de dados.
- Limpar os dados do navegador ou perder o dispositivo sem uma cópia válida pode eliminar o cofre local.
- Esta versão não substitui um sistema clínico nem deve ser usada para gerir emergências médicas.
