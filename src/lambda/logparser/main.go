package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/firehose"
	"github.com/aws/aws-sdk-go-v2/service/firehose/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	parser "github.com/nekrassov01/access-log-parser"
)

const (
	maxRecs = 400             // limit: 500
	maxSize = 3 * 1024 * 1024 // limit: 4MiB
)

var cfg aws.Config

func init() {
	var err error
	cfg, err = config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatalf("cannot load aws sdk config: %v", err)
	}
}

func getResourceMap(name string) (map[string]string, error) {
	s := os.Getenv(name)
	if s == "" {
		return nil, fmt.Errorf("failed to get value from environment variable \"%s\"", name)
	}
	m := make(map[string]string)
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil, err
	}
	return m, nil
}

func getParser(ctx context.Context, buf *bytes.Buffer, k, v string) (parser.Parser, error) {
	lineHandler := func(labels, values []string, isFirst bool) (string, error) {
		ls := make([]string, 0, len(labels)+2)
		ls = append(ls, "resource_type", "resource_name")
		ls = append(ls, labels...)
		vs := make([]string, 0, len(values)+2)
		vs = append(vs, v, k)
		vs = append(vs, values...)
		return parser.JSONLineHandler(ls, vs, isFirst)
	}
	opt := parser.Option{
		LineHandler: lineHandler,
	}
	ec2opt := parser.Option{
		LineHandler: lineHandler,
		Filters:     []string{"user_agent !~* ^ELB-HealthChecker"},
	}
	cfopt := parser.Option{
		LineHandler: lineHandler,
		SkipLines:   []int{1, 2},
	}
	var p parser.Parser
	switch v {
	case "clf":
		p = parser.NewApacheCLFRegexParser(ctx, buf, ec2opt)
	case "clfv":
		p = parser.NewApacheCLFWithVHostRegexParser(ctx, buf, ec2opt)
	case "s3":
		p = parser.NewS3RegexParser(ctx, buf, opt)
	case "cf":
		p = parser.NewCFRegexParser(ctx, buf, cfopt)
	case "alb":
		p = parser.NewALBRegexParser(ctx, buf, opt)
	case "nlb":
		p = parser.NewNLBRegexParser(ctx, buf, opt)
	case "clb":
		p = parser.NewCLBRegexParser(ctx, buf, opt)
	default:
		return nil, fmt.Errorf("invalid resource type: \"%s\"", v)
	}
	return p, nil
}

func splitData(data []byte) [][]byte {
	var (
		chunks [][]byte
		chunk  []byte
		count  int
		size   int
	)
	for _, record := range bytes.Split(data, []byte("\n")) {
		if count >= maxRecs || size+len(record)+1 > maxSize {
			chunks = append(chunks, chunk)
			chunk = nil
			count = 0
			size = 0
		}
		chunk = append(chunk, record...)
		chunk = append(chunk, '\n')
		count++
		size += len(record) + 1
	}
	if len(chunk) > 0 {
		chunks = append(chunks, chunk)
	}
	return chunks
}

func handleRequest(ctx context.Context, event events.SQSEvent) error {
	rmap, err := getResourceMap("RESOURCE_MAP")
	if err != nil {
		return err
	}
	buf := &bytes.Buffer{}
	s3client := s3.NewFromConfig(cfg)
	firehoseClient := firehose.NewFromConfig(cfg)
	for _, record := range event.Records {
		var s3event *events.S3Event
		if err := json.Unmarshal([]byte(record.Body), &s3event); err != nil {
			return err
		}
		for _, rec := range s3event.Records {
			key := rec.S3.Object.Key
			name := strings.Split(key, "/")[0]
			obj, err := s3client.GetObject(ctx, &s3.GetObjectInput{
				Bucket: aws.String(rec.S3.Bucket.Name),
				Key:    aws.String(key),
			})
			if err != nil {
				return err
			}
			j, _ := json.Marshal(map[string]string{"key": key})
			fmt.Println(string(j))
			v, ok := rmap[name]
			if !ok {
				fmt.Printf("skip because cannot determine log format of \"%s\"\n", name)
				continue
			}
			p, err := getParser(ctx, buf, name, v)
			if err != nil {
				return err
			}
			r, err := gzip.NewReader(obj.Body)
			if err != nil {
				return err
			}
			defer r.Close()
			result, err := p.Parse(r)
			if err != nil {
				return err
			}
			b, err := json.Marshal(result)
			if err != nil {
				return err
			}
			fmt.Println(string(b))
		}
	}
	if buf.Len() == 0 {
		return fmt.Errorf("abort process because buffer is empty")
	}
	for _, data := range splitData(buf.Bytes()) {
		resp, err := firehoseClient.PutRecordBatch(ctx, &firehose.PutRecordBatchInput{
			DeliveryStreamName: aws.String(os.Getenv("FIREHOSE_STREAM_NAME")),
			Records: []types.Record{
				{
					Data: data,
				},
			},
		})
		if err != nil {
			return err
		}
		if resp != nil {
			b, err := json.Marshal(resp)
			if err != nil {
				return err
			}
			fmt.Println(string(b))
		}
	}
	return nil
}

func main() {
	lambda.Start(handleRequest)
}
