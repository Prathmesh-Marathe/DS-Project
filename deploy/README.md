# AWS EKS Deployment Runbook

This repo is ready through ECR image publishing. As of the last check:

- AWS account: `027824090102`
- AWS region: `ap-south-1`
- ECR images exist for all six backend services with the `latest` tag
- S3 bucket `derrcs-incidents` exists
- Lambda function `derrcs-dispatch-logger` is active
- No EKS cluster currently exists in `ap-south-1`
- Worker nodes use `t3.small` because this AWS account rejects non-free-tier EC2 node types.

## 1. Create the EKS cluster

Use the saved config instead of a long inline command. EKS creation commonly takes 15-30 minutes.

```powershell
.\eksctl.exe create cluster -f deploy\eks\cluster.yaml --timeout 45m
```

If the command times out locally, check whether AWS is still creating resources:

```powershell
aws eks list-clusters --region ap-south-1
aws cloudformation list-stacks --region ap-south-1 --query "StackSummaries[?contains(StackName, 'eksctl-derrcs-cluster')].[StackName,StackStatus,CreationTime]" --output table
```

## 2. Connect kubectl

The local `kubectl.exe` is v1.30. If `eksctl` creates the current default EKS version, update `kubectl` to the same minor version shown by the `eksctl` dry-run before applying manifests.

```powershell
aws eks update-kubeconfig --region ap-south-1 --name derrcs-cluster
.\kubectl.exe get nodes
```

## 3. Create Kubernetes secrets

The local `.env` has the needed keys. Do not commit generated secret YAML.

```powershell
.\kubectl.exe create namespace derrcs
.\kubectl.exe create secret generic derrcs-secrets --namespace derrcs --from-env-file=.env
```

If the namespace already exists, the first command can fail harmlessly.

## 4. Deploy backend services

```powershell
.\kubectl.exe apply -f deploy\k8s
.\kubectl.exe get pods,svc -n derrcs
```

The `registry-public` service exposes the registry through an AWS LoadBalancer while keeping other services cluster-internal.

## 5. Important frontend note

The current React app hardcodes `REGISTRY_URL` as `http://localhost:5000` in `frontend/src/App.jsx`, so a CloudFront/S3 frontend will not automatically talk to the AWS backend. Before Step 11/12, change that value to a build-time environment variable or rebuild the frontend with the deployed registry/ALB URL.

## 6. Clean up cluster if needed

```powershell
.\eksctl.exe delete cluster -f deploy\eks\cluster.yaml --wait
```
