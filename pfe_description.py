from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib.enums import TA_JUSTIFY, TA_CENTER, TA_LEFT
from reportlab.lib.colors import HexColor
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle
)

OUT = r"c:\upwork-scrapper\PFE_Description_BIAT.pdf"

styles = getSampleStyleSheet()
NAVY = HexColor("#0B3D91")
GREY = HexColor("#444444")

h_title = ParagraphStyle("h_title", parent=styles["Title"], fontSize=20,
                         textColor=NAVY, alignment=TA_CENTER, spaceAfter=18)
h_sub = ParagraphStyle("h_sub", parent=styles["Normal"], fontSize=12,
                       textColor=GREY, alignment=TA_CENTER, spaceAfter=24)
h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=15,
                    textColor=NAVY, spaceBefore=14, spaceAfter=8)
h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=12.5,
                    textColor=NAVY, spaceBefore=10, spaceAfter=6)
p  = ParagraphStyle("p", parent=styles["Normal"], fontSize=10.5,
                    alignment=TA_JUSTIFY, leading=15, spaceAfter=6)
bullet = ParagraphStyle("bullet", parent=p, leftIndent=14, bulletIndent=2)
note = ParagraphStyle("note", parent=p, textColor=GREY, fontSize=9.5,
                      leftIndent=10, rightIndent=10, spaceBefore=6, spaceAfter=6)

story = []

# ── Cover ────────────────────────────────────────────────────────────────────
story += [
    Spacer(1, 3*cm),
    Paragraph("Projet de Fin d&rsquo;&Eacute;tudes", h_title),
    Paragraph("Pr&eacute;diction des cours boursiers et impact inter-bancaire : "
              "cas des actions de la BIAT et de 7 banques tunisiennes cot&eacute;es",
              ParagraphStyle("cover_sub", parent=styles["Normal"], fontSize=14,
                             textColor=GREY, alignment=TA_CENTER, spaceAfter=30, leading=20)),
    Spacer(1, 1*cm),
    Paragraph("Stage effectu&eacute; au sein de la <b>Banque Internationale Arabe de Tunisie (BIAT)</b>",
              ParagraphStyle("cover_org", parent=styles["Normal"], fontSize=12,
                             alignment=TA_CENTER, textColor=NAVY)),
    Spacer(1, 4*cm),
    Paragraph("Document de cadrage &mdash; Plan propos&eacute; (3 chapitres &middot; 2 sections par chapitre)",
              ParagraphStyle("cover_foot", parent=styles["Normal"], fontSize=10,
                             alignment=TA_CENTER, textColor=GREY)),
    PageBreak(),
]

# ── Résumé / Description générale ─────────────────────────────────────────────
story += [
    Paragraph("1. Description g&eacute;n&eacute;rale du projet", h1),
    Paragraph(
        "Ce projet de fin d&rsquo;&eacute;tudes, men&eacute; dans le cadre d&rsquo;un stage "
        "&agrave; la <b>Banque Internationale Arabe de Tunisie (BIAT)</b>, a pour "
        "objectif d&rsquo;analyser le comportement boursier de l&rsquo;action BIAT et "
        "de sept autres banques tunisiennes cot&eacute;es &agrave; la BVMT (par "
        "exemple ATB, Amen Bank, Attijari Bank, BH Bank, BNA, BT, STB, UBCI &mdash; liste "
        "&agrave; confirmer selon disponibilit&eacute; des donn&eacute;es).", p),
    Paragraph(
        "L&rsquo;&eacute;tude poursuit trois finalit&eacute;s&nbsp;: (i) "
        "<b>pr&eacute;dire</b> les cours futurs des actions &agrave; l&rsquo;aide de "
        "mod&egrave;les &eacute;conom&eacute;triques et d&rsquo;apprentissage "
        "automatique (ARIMA, GARCH, LSTM, Prophet)&nbsp;; (ii) <b>mesurer "
        "l&rsquo;impact</b> de la variation du cours d&rsquo;une banque sur les autres "
        "(corr&eacute;lation, causalit&eacute; de Granger, mod&egrave;le VAR, analyse "
        "de co-int&eacute;gration)&nbsp;; (iii) <b>proposer une strat&eacute;gie</b> "
        "concr&egrave;te pour am&eacute;liorer la performance boursi&egrave;re de "
        "l&rsquo;action BIAT.", p),
    Paragraph(
        "Le travail se structure en trois chapitres, chacun compos&eacute; de deux "
        "sections, comme d&eacute;taill&eacute; ci-apr&egrave;s.", p),
    Spacer(1, 0.4*cm),
]

# ── Plan global ──────────────────────────────────────────────────────────────
data = [
    ["Chapitre", "Section 1", "Section 2"],
    ["Ch.1 — Cadre théorique et environnement bancaire",
     "Le syst&egrave;me bancaire tunisien et la BVMT",
     "Les march&eacute;s financiers et la valorisation des actions bancaires"],
    ["Ch.2 — Méthodologie : prédiction & impact inter-bancaire",
     "M&eacute;thodes de pr&eacute;vision des s&eacute;ries temporelles financi&egrave;res",
     "Mesure de l&rsquo;impact et de la contagion entre actions bancaires"],
    ["Ch.3 — Cas pratique BIAT",
     "Pr&eacute;sentation du lieu de stage (BIAT)",
     "Cas pratique&nbsp;: pr&eacute;diction, impact et strat&eacute;gie"],
]
# Wrap cells as paragraphs
plan_style = ParagraphStyle("plan", parent=p, fontSize=9.5, leading=13, alignment=TA_LEFT)
head_style = ParagraphStyle("plan_h", parent=plan_style, textColor=HexColor("#FFFFFF"),
                            fontName="Helvetica-Bold")
wrapped = []
for i, row in enumerate(data):
    s = head_style if i == 0 else plan_style
    wrapped.append([Paragraph(c, s) for c in row])

t = Table(wrapped, colWidths=[4.2*cm, 6*cm, 6*cm], repeatRows=1)
t.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), NAVY),
    ("GRID", (0,0), (-1,-1), 0.4, HexColor("#BBBBBB")),
    ("VALIGN", (0,0), (-1,-1), "TOP"),
    ("LEFTPADDING", (0,0), (-1,-1), 6),
    ("RIGHTPADDING", (0,0), (-1,-1), 6),
    ("TOPPADDING", (0,0), (-1,-1), 6),
    ("BOTTOMPADDING", (0,0), (-1,-1), 6),
    ("ROWBACKGROUNDS", (0,1), (-1,-1), [HexColor("#F5F7FB"), HexColor("#FFFFFF")]),
]))
story += [Paragraph("Plan g&eacute;n&eacute;ral du m&eacute;moire", h2), t, Spacer(1, 0.5*cm)]

# ── Chapitre 1 ───────────────────────────────────────────────────────────────
story += [
    Paragraph("Chapitre 1 &mdash; Cadre th&eacute;orique et environnement bancaire", h1),
    Paragraph(
        "<b>Objectif&nbsp;:</b> poser les fondations th&eacute;oriques et contextuelles "
        "du m&eacute;moire. Ce chapitre d&eacute;crit l&rsquo;&eacute;cosyst&egrave;me "
        "dans lequel &eacute;volue la BIAT (syst&egrave;me bancaire tunisien, "
        "BVMT), puis explique comment une action bancaire est valoris&eacute;e "
        "sur les march&eacute;s financiers.", p),

    Paragraph("Section 1 &mdash; Le syst&egrave;me bancaire tunisien et la BVMT", h2),
    Paragraph("&bull; Pr&eacute;sentation du secteur bancaire tunisien&nbsp;: acteurs, "
              "r&eacute;gulation (BCT), poids dans l&rsquo;&eacute;conomie.", bullet),
    Paragraph("&bull; La Bourse des Valeurs Mobili&egrave;res de Tunis (BVMT)&nbsp;: "
              "fonctionnement, indices (TUNINDEX, TUNBANK), liquidit&eacute;.", bullet),
    Paragraph("&bull; Positionnement des 8 banques cot&eacute;es &eacute;tudi&eacute;es "
              "(dont la BIAT) dans l&rsquo;indice TUNBANK.", bullet),

    Paragraph("Section 2 &mdash; Les march&eacute;s financiers et la valorisation des actions bancaires", h2),
    Paragraph("&bull; Notions de base&nbsp;: action, cours, rendement, volatilit&eacute;, "
              "capitalisation boursi&egrave;re.", bullet),
    Paragraph("&bull; M&eacute;thodes de valorisation&nbsp;: analyse fondamentale "
              "(PER, PBR, dividendes) vs analyse technique.", bullet),
    Paragraph("&bull; Sp&eacute;cificit&eacute;s des actions bancaires&nbsp;: sensibilit&eacute; "
              "aux taux d&rsquo;int&eacute;r&ecirc;t, au risque syst&eacute;mique et aux "
              "chocs macro-&eacute;conomiques.", bullet),
    Spacer(1, 0.3*cm),
]

# ── Chapitre 2 ───────────────────────────────────────────────────────────────
story += [
    Paragraph("Chapitre 2 &mdash; M&eacute;thodologie&nbsp;: pr&eacute;diction &amp; impact inter-bancaire", h1),
    Paragraph(
        "<b>Objectif&nbsp;:</b> pr&eacute;senter les outils quantitatifs qui seront "
        "appliqu&eacute;s dans le cas pratique. Ce chapitre est le <b>pilier "
        "m&eacute;thodologique</b> du m&eacute;moire&nbsp;: il justifie les mod&egrave;les "
        "choisis pour la pr&eacute;vision des cours et pour la mesure de "
        "l&rsquo;interd&eacute;pendance entre les actions bancaires.", p),

    Paragraph("Section 1 &mdash; M&eacute;thodes de pr&eacute;vision des s&eacute;ries temporelles financi&egrave;res", h2),
    Paragraph("&bull; Analyse des s&eacute;ries temporelles&nbsp;: stationnarit&eacute; "
              "(test ADF), autocorr&eacute;lation, saisonnalit&eacute;.", bullet),
    Paragraph("&bull; Mod&egrave;les classiques&nbsp;: <b>ARIMA / SARIMA</b> pour la "
              "tendance, <b>GARCH</b> pour la volatilit&eacute;.", bullet),
    Paragraph("&bull; Mod&egrave;les de <i>machine learning</i> et <i>deep learning</i>&nbsp;: "
              "<b>LSTM</b>, <b>GRU</b>, <b>Prophet</b>, XGBoost sur <i>features</i> techniques.", bullet),
    Paragraph("&bull; Crit&egrave;res d&rsquo;&eacute;valuation&nbsp;: RMSE, MAE, MAPE, "
              "<i>directional accuracy</i>.", bullet),

    Paragraph("Section 2 &mdash; Mesure de l&rsquo;impact et de la contagion entre actions bancaires", h2),
    Paragraph("&bull; Corr&eacute;lation et co-mouvement&nbsp;: matrice de Pearson, "
              "corr&eacute;lations dynamiques (DCC-GARCH).", bullet),
    Paragraph("&bull; <b>Causalit&eacute; de Granger</b>&nbsp;: quelle banque "
              "&laquo;&nbsp;influence&nbsp;&raquo; les autres&nbsp;?", bullet),
    Paragraph("&bull; <b>Mod&egrave;le VAR</b> (Vector Autoregression) et fonctions de "
              "r&eacute;ponse impulsionnelle pour quantifier l&rsquo;impact d&rsquo;un "
              "choc sur une action vers les autres.", bullet),
    Paragraph("&bull; Co-int&eacute;gration (Engle-Granger, Johansen) pour d&eacute;tecter "
              "les relations d&rsquo;&eacute;quilibre de long terme.", bullet),
    Spacer(1, 0.3*cm),
]

# ── Chapitre 3 ───────────────────────────────────────────────────────────────
story += [
    Paragraph("Chapitre 3 &mdash; Cas pratique &agrave; la BIAT", h1),

    Paragraph("Section 1 &mdash; Description du lieu de stage (BIAT)", h2),
    Paragraph("&bull; Historique, missions et organisation de la BIAT.", bullet),
    Paragraph("&bull; Place de la BIAT dans le paysage bancaire tunisien et &agrave; la BVMT.", bullet),
    Paragraph("&bull; Pr&eacute;sentation du d&eacute;partement d&rsquo;accueil et des t&acirc;ches r&eacute;alis&eacute;es.", bullet),

    Paragraph("Section 2 &mdash; Cas pratique&nbsp;: pr&eacute;diction, impact et strat&eacute;gie", h2),
    Paragraph("&bull; Collecte et nettoyage des cours historiques des 8 banques (BIAT + 7).", bullet),
    Paragraph("&bull; Application des mod&egrave;les du chapitre 2 pour pr&eacute;dire les "
              "cours futurs de chaque action.", bullet),
    Paragraph("&bull; Analyse de l&rsquo;impact crois&eacute;&nbsp;: quelles banques "
              "tirent l&rsquo;action BIAT &agrave; la hausse&nbsp;/ &agrave; la baisse&nbsp;?", bullet),
    Paragraph("&bull; <b>Proposition d&rsquo;une strat&eacute;gie</b> pour am&eacute;liorer "
              "la performance boursi&egrave;re de l&rsquo;action BIAT "
              "(communication financi&egrave;re, politique de dividende, gestion du "
              "<i>free float</i>, signaux de <i>buyback</i>, suivi d&rsquo;indicateurs "
              "d&rsquo;alerte bas&eacute;s sur les pairs).", bullet),
    Spacer(1, 0.4*cm),
]

# ── Recommandation ──────────────────────────────────────────────────────────
story += [
    Paragraph("2. Recommandation pour les chapitres 1 et 2", h1),
    Paragraph(
        "Parmi les orientations possibles, la combinaison <b>la plus coh&eacute;rente</b> "
        "avec votre cas pratique est la suivante&nbsp;:", p),
    Paragraph("<b>Chapitre 1&nbsp;&mdash; Cadre th&eacute;orique et environnement bancaire</b> "
              "(syst&egrave;me bancaire tunisien &amp; BVMT + valorisation des actions "
              "bancaires). Il <b>contextualise</b> le terrain d&rsquo;&eacute;tude et "
              "justifie le choix des 8 banques.", p),
    Paragraph("<b>Chapitre 2&nbsp;&mdash; M&eacute;thodologie&nbsp;: pr&eacute;diction &amp; "
              "impact inter-bancaire</b> (s&eacute;ries temporelles + mod&egrave;les VAR/"
              "Granger). Il <b>outille</b> directement le cas pratique du chapitre&nbsp;3 "
              "sans doublon.", p),
    Paragraph(
        "Cette r&eacute;partition respecte la logique classique "
        "<i>contexte &rarr; outils &rarr; application</i>, &eacute;vite la redondance, "
        "et permet une transition naturelle vers la section pratique o&ugrave; vous "
        "appliquerez exactement ce qui a &eacute;t&eacute; expos&eacute; au chapitre&nbsp;2.", note),
]

doc = SimpleDocTemplate(
    OUT, pagesize=A4,
    leftMargin=2*cm, rightMargin=2*cm,
    topMargin=1.8*cm, bottomMargin=1.8*cm,
    title="PFE — BIAT : Prédiction des cours et impact inter-bancaire"
)
doc.build(story)
print("OK ->", OUT)
