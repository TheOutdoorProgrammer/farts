{{- define "farts.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "farts.fullname" -}}
{{- default (printf "%s-%s" .Release.Name (include "farts.name" .)) .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "farts.selectorLabels" -}}
app.kubernetes.io/name: {{ include "farts.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "farts.labels" -}}
{{- $chart := printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 -}}
{{ include "farts.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ regexReplaceAll "[-_.]+$" $chart "" | quote }}
{{- end -}}
