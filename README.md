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


A versão instalável está publicada em [Gestão Médica Pessoal](https://tabernalusitanapt.github.io/Gestao-Medica-Pessoal/). No Android, abra essa ligação no Chrome e escolha **Instalar aplicação** ou **Adicionar ao ecrã inicial** no menu do navegador. Depois do primeiro carregamento, a app pode ser aberta offline.

Para experimentar no computador, sirva esta pasta em `localhost` e abra o endereço no navegador. O acesso a funcionalidades protegidas do navegador, como armazenamento e notificações, requer um contexto seguro (`HTTPS` ou `localhost`).


Na primeira abertura, crie um PIN de seis dígitos. Em qualquer tipo de registo, pode escolher uma imagem ou PDF ou tirar uma fotografia: **Fotografar documento** pede autorização à câmara e abre a câmara traseira no Android ou a webcam no computador. Se o acesso direto não estiver disponível ou for recusado, pode usar a câmara do dispositivo como alternativa. Depois da captura, escolha **Ler documento e preencher dados** e confirme as sugestões antes de guardar. O acesso direto à câmara requer HTTPS ou `localhost` e autorização do navegador. O motor OCR e o modelo português, bem como o leitor PDF, são carregados localmente; os documentos não são enviados para serviços externos. Para PDFs digitalizados, o OCR analisa apenas a primeira página; texto selecionável pode ser extraído dessa página. Cada documento PDF pode ter até 20 MB.


As datas são mostradas no formato `DD/MM/AAAA`. No formulário, também podem ser digitadas diretamente nesse formato.


## Publicação no GitHub Pages


O site é estático e pode ser publicado diretamente nesta pasta, sem processo de compilação. O workflow em `.github/workflows/pages.yml` publica automaticamente o conteúdo quando há um push para `main` ou quando é iniciado manualmente.
